import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { BackgroundService, BackgroundSpecSchema, MemoryBackgroundRepository } from "../src/background/index.js";
import { createBackgroundRouter, createSourceAutomationRouter } from "../src/background/routes.js";
import { ControllerServer } from "../src/http/server.js";
import { MemoryStore } from "../src/store/memory.js";

const BASE = Date.parse("2026-10-18T00:00:00Z");
const servers: Server[] = [];
const controllers: ControllerServer[] = [];
afterEach(async () => {
  await Promise.all(controllers.splice(0).map(server => server.stop()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
});
async function listen(app: express.Express): Promise<string> {
  const server = app.listen(0, "127.0.0.1"); servers.push(server);
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing HTTP address");
  return `http://127.0.0.1:${address.port}`;
}
async function fixture() {
  let now = BASE;
  const repository = new MemoryBackgroundRepository();
  const service = new BackgroundService({ repository, now: () => now,
    runtime: { start: async () => ({ status: "running" }), inspect: async () => ({ status: "running" }),
      exportArtifacts: async () => [], cancel: async () => undefined, cleanup: async () => undefined },
    sources: { inspectAutomation: async () => { throw new Error("Unexpected source inspection"); } }, deliverSupplement: async () => undefined });
  const runId = randomUUID();
  await service.start({ id: runId, scheduleId: randomUUID(), chatId: "owner", scheduledAt: BASE },
    BackgroundSpecSchema.parse({ prompt: "p".repeat(1_000), preferences: ["secret-preference"] }));
  const worker = (await repository.getByRun(runId))!;
  await repository.update(worker.id, current => {
    current.invocations[0].receipt = { status: "running", artifacts: [{ name: "out.txt", path: "/private/artifacts/out.txt", size: 1, sha256: "a".repeat(64) }] };
  });
  const app = express(); app.use(express.json());
  const allowed = new Set(["owner", "other"]);
  app.use("/tasks", createBackgroundRouter(service, () => allowed));
  const origin = await listen(app);
  const post = (suffix: string, body: unknown) => fetch(`${origin}/tasks/${runId}/${suffix}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { origin, runId, worker, repository, service, allowed, post, setTime: (value: number) => { now = value; } };
}

describe("background task HTTP", () => {
  it("lists and reads public state without model input or local artifact receipts", async () => {
    const f = await fixture();
    const listed = await (await fetch(`${f.origin}/tasks?chatId=owner`)).json();
    expect(listed.tasks).toHaveLength(1);
    expect(listed.tasks[0]).toMatchObject({ runId: f.runId, executing: true });
    expect(listed.tasks[0].task).toHaveLength(256);
    const response = await fetch(`${f.origin}/tasks/${f.runId}?chatId=owner`);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain("/private/artifacts");
    expect(text).not.toContain("secret-preference");
    expect(text).not.toContain('"receipt"');
    expect(text).not.toContain('"input"');
  });
  it("enforces allowlist, chat ownership and strict request schemas before mutation", async () => {
    const f = await fixture();
    expect((await fetch(`${f.origin}/tasks?chatId=blocked`)).status).toBe(403);
    expect((await fetch(`${f.origin}/tasks/${f.runId}?chatId=other`)).status).toBe(404);
    expect((await f.post("follow-up", { chatId: "other", prompt: "hello", requestId: "one" })).status).toBe(404);
    expect((await f.post("extend", { chatId: "other", expiresAt: "2026-10-19T01:00:00Z" })).status).toBe(404);
    expect((await f.post("follow-up", { chatId: "owner", prompt: "hello", requestId: "one", authorized: true })).status).toBe(400);
    expect((await fetch(`${f.origin}/tasks?chatId=owner&chatId=other`)).status).toBe(400);
    expect((await f.repository.get(f.worker.id))!.prompts).toHaveLength(0);
    f.allowed.delete("owner");
    expect((await f.post("follow-up", { chatId: "owner", prompt: "hello", requestId: "one" })).status).toBe(403);
  });
  it("queues idempotent follow-ups and extends only explicit valid requests", async () => {
    const f = await fixture();
    const request = { chatId: "owner", prompt: "再检查结果", requestId: "user-request-1" };
    expect((await f.post("follow-up", request)).status).toBe(202);
    expect((await f.post("follow-up", request)).status).toBe(202);
    expect((await f.repository.get(f.worker.id))!.prompts).toHaveLength(1);
    expect((await f.post("follow-up", { ...request, prompt: "different" })).status).toBe(409);
    expect((await f.repository.get(f.worker.id))!.expiresAt).toBe(f.worker.expiresAt);
    f.setTime(BASE + 3_600_000);
    const extended = await f.post("extend", { chatId: "owner", expiresAt: "2026-10-19T01:00:00Z" });
    expect(extended.status).toBe(200);
    expect((await extended.json()).task.expiresAt).toBe(BASE + 25 * 3_600_000);
    expect((await f.post("extend", { chatId: "owner", expiresAt: "2026-10-20T01:00:00Z" })).status).toBe(409);
  });
  it("reports disabled execution without accepting work", async () => {
    const app = express(); app.use(createBackgroundRouter(undefined, () => new Set(["owner"])));
    expect((await fetch(`${await listen(app)}/?chatId=owner`)).status).toBe(503);
  });
  it("reads exact discovered source occurrences and never returns source prompts", async () => {
    const inspectAutomation = vi.fn(async (_nodeId, options) => ({ ...options, status: "running", sources: ["automation_runs"], observedAt: BASE }));
    const listAutomations = vi.fn(async () => [{ id: "daily", name: "Daily", kind: "heartbeat" as const, status: "ACTIVE", prompt: "private-source-prompt", rrule: "daily" }]);
    const app = express(); app.use(createSourceAutomationRouter({ getNodeStatusList: () => [{ nodeId: "mini" }] as never,
      listAutomations, inspectAutomation }));
    const origin = await listen(app);
    expect((await fetch(`${origin}/?nodeId=unknown`)).status).toBe(404);
    expect(listAutomations).not.toHaveBeenCalled();
    const list = await fetch(`${origin}/?nodeId=mini`);
    expect(await list.text()).not.toContain("private-source-prompt");
    expect((await fetch(`${origin}/daily?nodeId=mini&expectedAt=${BASE}&notAfter=${BASE + 60_000}`)).status).toBe(200);
    expect(inspectAutomation).toHaveBeenCalledWith("mini", { automationId: "daily", expectedAt: BASE, notAfter: BASE + 60_000 });
    expect((await fetch(`${origin}/missing?nodeId=mini&expectedAt=${BASE}&notAfter=${BASE + 60_000}`)).status).toBe(404);
    expect((await fetch(`${origin}/daily?nodeId=mini&expectedAt=${BASE}&notAfter=${BASE - 1}`)).status).toBe(400);
    expect(inspectAutomation).toHaveBeenCalledTimes(1);
    listAutomations.mockRejectedValueOnce(new Error("private-db-path-and-password"));
    const failed = await fetch(`${origin}/?nodeId=mini`);
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain("private-db-path-and-password");
  });
  it("requires admin bearer and grants no new API powers to a valid console cookie", async () => {
    const server = new ControllerServer({ port: 0, host: "127.0.0.1", controllerToken: "admin",
      tokenToNode: new Map(), nodeTokens: {}, persistenceMode: "memory", commandTtlSeconds: 60,
      consolePublicUrl: "http://127.0.0.1:8790", allowedChatIds: new Set(["owner"]) }, new MemoryStore());
    controllers.push(server); await server.start();
    const address = server.getHttpServer().address(); if (!address || typeof address === "string") throw new Error("Missing address");
    const origin = `http://127.0.0.1:${address.port}`;
    const link = await (await fetch(`${origin}/v1/console-links`, { method: "POST", headers: { Authorization: "Bearer admin", "Content-Type": "application/json" }, body: JSON.stringify({ requestId: "background-auth" }) })).json();
    const exchange = await fetch(`${origin}/auth/exchange`, { method: "POST", headers: { Origin: "http://127.0.0.1:8790", "Content-Type": "application/json" }, body: JSON.stringify({ token: new URL(link.url).hash.slice("#login=".length) }) });
    expect(exchange.status).toBe(200);
    const cookie = exchange.headers.get("set-cookie")!.split(";")[0];
    expect((await fetch(`${origin}/v1/status`, { headers: { Cookie: cookie } })).status).toBe(200);
    for (const path of ["/background-tasks?chatId=owner", "/source-automations?nodeId=mini"]) {
      expect((await fetch(origin + "/v1" + path)).status).toBe(401);
      expect((await fetch(origin + "/v1" + path, { headers: { Cookie: cookie } })).status).toBe(401);
    }
    expect((await fetch(`${origin}/v1/background-tasks?chatId=owner`, { headers: { Authorization: "Bearer admin" } })).status).toBe(503);
    expect((await fetch(`${origin}/v1/background-tasks/${randomUUID()}/follow-up`, { method: "POST", headers: { Cookie: cookie, Origin: "http://127.0.0.1:8790", "Content-Type": "application/json", "X-Super-Leader-Intent": "session-message" }, body: JSON.stringify({ chatId: "owner", prompt: "hello", requestId: "one" }) })).status).toBe(401);
  });
});
