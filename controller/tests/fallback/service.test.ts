import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FallbackService, MemoryFallbackRepository, parseFallbackEndpoints, type FallbackInput } from "../../src/fallback/index.js";

const input: FallbackInput = { key: "task:123", chatId: "chat-1", kind: "completed", title: "研究已完成", text: "摘要正文", resultId: "result-123", resultStatus: "completed" };
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  })));
});
async function listen(handler: Parameters<typeof createServer>[0]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/notify`;
}
function fixture(fetcher?: typeof fetch, endpoint = "https://example.test/webhook") {
  const repository = new MemoryFallbackRepository();
  let now = 1_000;
  const service = new FallbackService(repository, { endpoints: new Map([[input.chatId, endpoint]]), now: () => now, fetch: fetcher });
  return { repository, service, advance: (delta: number) => { now += delta; } };
}

describe("fallback webhook configuration", () => {
  it("defaults disabled and rejects unsafe endpoint configuration", () => {
    expect(parseFallbackEndpoints().size).toBe(0);
    for (const url of ["http://example.com", "https://user:secret@example.com", "https://example.com/#token", "file:///tmp/x"]) {
      expect(() => parseFallbackEndpoints(JSON.stringify({ chat: url }))).toThrow();
    }
    expect(parseFallbackEndpoints('{"chat":"http://127.0.0.1:321/notify"}').get("chat")).toContain("127.0.0.1");
  });
  it("does not enqueue for an unmapped chat", async () => {
    const { service, repository } = fixture();
    expect(await service.enqueue({ ...input, chatId: "other" })).toBeUndefined();
    expect(await repository.list("other")).toEqual([]);
  });
});

describe("durable fallback delivery", () => {
  it("sends once to a real synthetic server with a freshly materialized result link", async () => {
    const payloads: Record<string, unknown>[] = [];
    const endpoint = await listen((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => { payloads.push(JSON.parse(body)); response.writeHead(202).end(); });
    });
    const repository = new MemoryFallbackRepository();
    const materialize = vi.fn(async () => ({ url: "https://results.example.test/r/123?cap=single-result", resultStatus: "completed" }));
    const service = new FallbackService(repository, { endpoints: new Map([[input.chatId, endpoint]]), materialize });
    const record = await service.enqueue(input);
    expect(materialize).not.toHaveBeenCalled();
    expect((await service.enqueue({ ...input, text: "a conflicting retry" }))!.id).toBe(record!.id);
    await Promise.all([service.drain(), service.drain()]);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ resultUrl: "https://results.example.test/r/123?cap=single-result", resultStatus: "completed", text: input.text });
    expect(payloads[0]).not.toHaveProperty("chatId");
    expect((await repository.get(record!.id))!.status).toBe("sent");
    expect((await repository.get(record!.id))!.outcome).toBe("endpoint_accepted_http_202");
  });
  it("does not follow redirect responses", async () => {
    let redirected = false;
    const target = await listen((_request, response) => { redirected = true; response.end(); });
    const endpoint = await listen((_request, response) => { response.writeHead(302, { location: target }).end(); });
    const { service, repository } = fixture(undefined, endpoint);
    const record = await service.enqueue(input);
    await service.drain();
    expect(redirected).toBe(false);
    expect((await repository.get(record!.id))!.status).toBe("failed");
  });
  it.each([400, 401, 403, 404])("records HTTP %s as a definite rejection", async (status) => {
    const { service, repository } = fixture(vi.fn(async () => new Response(null, { status })) as typeof fetch);
    const record = await service.enqueue(input);
    await service.drain();
    expect((await repository.get(record!.id))!.status).toBe("failed");
    expect(await service.drain()).toBe(0);
  });
  it.each([500, 503])("does not resend an HTTP %s outcome that may already have processed", async (status) => {
    const { service, repository } = fixture(vi.fn(async () => new Response(null, { status })) as typeof fetch);
    const record = await service.enqueue(input);
    await service.drain();
    expect((await repository.get(record!.id))!.status).toBe("unknown");
    expect(await service.drain()).toBe(0);
  });
  it("retries only pre-submission connection failure, with bounded backoff", async () => {
    const fetcher = vi.fn(async () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) }); });
    const { service, repository, advance } = fixture(fetcher as typeof fetch);
    const record = await service.enqueue(input);
    await service.drain();
    expect((await repository.get(record!.id))!.status).toBe("pending");
    expect(await service.drain()).toBe(0);
    for (let attempt = 1; attempt < 5; attempt++) { advance(1_000_000); await service.drain(); }
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect((await repository.get(record!.id))!.status).toBe("failed");
  });
  it("retries a rate-limited rejection later", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 429 }));
    const { service, repository, advance } = fixture(fetcher as typeof fetch);
    const record = await service.enqueue(input);
    await service.drain();
    expect((await repository.get(record!.id))!.status).toBe("pending");
    expect(await service.drain()).toBe(0);
    advance(30_000);
    expect(await service.drain()).toBe(1);
  });
  it("keeps a connection reset unknown and never blindly retries", async () => {
    const fetcher = vi.fn(async () => { throw Object.assign(new Error("socket reset"), { code: "ECONNRESET" }); });
    const { service, repository, advance } = fixture(fetcher as typeof fetch);
    const record = await service.enqueue(input);
    await service.drain(); advance(1_000_000);
    expect(await service.drain()).toBe(0);
    expect((await repository.get(record!.id))!.status).toBe("unknown");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("preserves an active sender across initialization and allows its settlement", async () => {
    const repository = new MemoryFallbackRepository();
    const record = await repository.enqueue(input, 1_000);
    const claim = await repository.claim(1_000);
    await Promise.all([repository.init(2_000), repository.init(2_000)]);
    expect(await repository.get(record.id)).toMatchObject({ status: "sending", claimToken: claim!.claimToken, claimExpiresAt: 61_000 });
    await repository.settle(record.id, claim!.claimToken!, { status: "sent", outcome: "endpoint_accepted_http_202" }, 2_000);
    expect((await repository.get(record.id))!.status).toBe("sent");
  });
  it("recovers only an expired sending lease as unknown", async () => {
    const repository = new MemoryFallbackRepository();
    const record = await repository.enqueue(input, 1_000);
    const claim = await repository.claim(1_000);
    expect(claim!.status).toBe("sending");
    await repository.init(61_000);
    expect((await repository.get(record.id))!.status).toBe("unknown");
    expect(await repository.claim(70_000)).toBeUndefined();
    await expect(repository.settle(record.id, claim!.claimToken!, { status: "sent", outcome: "late" }, 70_000)).rejects.toThrow();
    expect((await repository.get(record.id))!.status).toBe("unknown");
  });
  it("does not submit HTTP after link materialization consumes its lease", async () => {
    let now = 1_000;
    const repository = new MemoryFallbackRepository();
    const fetcher = vi.fn(async () => new Response());
    const service = new FallbackService(repository, { endpoints: new Map([[input.chatId, "https://example.test/notify"]]),
      now: () => now, fetch: fetcher as typeof fetch, materialize: async () => { now = 50_000; return {}; } });
    const record = await service.enqueue(input);
    await expect(service.drain()).rejects.toThrow("claim no longer owned");
    expect(fetcher).not.toHaveBeenCalled();
    expect(await repository.get(record!.id)).toMatchObject({ status: "unknown", outcome: "submission_lease_expired" });
  });
  it("reclaims expired leases during polling without requiring process restart", async () => {
    const repository = new MemoryFallbackRepository();
    const record = await repository.enqueue(input, 1_000);
    await repository.claim(1_000, 2_000);
    expect(await repository.claim(3_000)).toBeUndefined();
    expect((await repository.get(record.id))!.status).toBe("unknown");
  });
  it("expires stale work before HTTP submission and retains the result status", async () => {
    const fetcher = vi.fn(async () => new Response());
    const { service, repository, advance } = fixture(fetcher as typeof fetch);
    const record = await service.enqueue({ ...input, expiresAt: 2_000 });
    advance(1_000);
    expect(await service.drain()).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await repository.get(record!.id)).toMatchObject({ status: "failed", resultStatus: "completed", outcome: "expired_before_submission" });
  });
});
