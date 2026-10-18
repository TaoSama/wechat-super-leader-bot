import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpLeaderModel } from "../../../src/leader/model/client.js";
import { modelDiagnostic } from "../../../src/leader/model/errors.js";

const config = { baseUrl: "https://model.example/v1", apiKey: "private-key", model: "test-model", retryDelayMs: 0 };
const messages = [{ role: "user" as const, content: "测试独立请求" }];
const replyBody = JSON.stringify({ status: "completed", output: [{
  type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "恢复成功" }],
}] });
const ok = () => new Response(replyBody);
const networkError = (code: string) => new TypeError("fetch failed", {
  cause: Object.assign(new Error("private-key https://private-provider.example/secret"), { code }),
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("model transport recovery", () => {
  it.each(["ECONNRESET", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"])("recovers from %s with the same request and deadline signal", async code => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(networkError(code)).mockImplementationOnce(async () => ok());
    const result = await new HttpLeaderModel({ ...config, fetchImpl: fetcher }).complete(messages, []);
    expect(result.content).toBe("恢复成功");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][1]?.body).toBe(fetcher.mock.calls[1][1]?.body);
    expect(fetcher.mock.calls[0][1]?.signal).toBe(fetcher.mock.calls[1][1]?.signal);
    expect(warn).toHaveBeenCalledWith("Leader model temporary transport failure; retry scheduled", {
      category: "transport", transportPhase: "fetch", causeCode: code, attempts: 1, delayMs: 0,
    });
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private-key|private-provider/);
  });

  it("recovers native fetch failures without a cause code", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError("fetch failed")).mockImplementationOnce(async () => ok());
    expect((await new HttpLeaderModel({ ...config, fetchImpl: fetcher }).complete(messages, [])).content).toBe("恢复成功");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("reports exhausted transient attempts with safe cause and phase diagnostics", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetcher = vi.fn<typeof fetch>(async () => { throw networkError("ECONNRESET"); });
    const failure = await new HttpLeaderModel({ ...config, fetchImpl: fetcher }).complete(messages, []).catch(error => error);
    expect(modelDiagnostic(failure)).toEqual({ category: "transport", transportPhase: "fetch", causeCode: "ECONNRESET", attempts: 3 });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(JSON.stringify({ failure, warnings: warn.mock.calls })).not.toMatch(/private-key|private-provider/);
    expect(failure.cause).toBeUndefined();
  });

  it("recovers an interrupted successful response body before accepting its output", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"status":"completed","output":['));
    }, pull(controller) { controller.error(networkError("UND_ERR_SOCKET")); } });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(broken)).mockImplementationOnce(async () => ok());
    expect((await new HttpLeaderModel({ ...config, fetchImpl: fetcher }).complete(messages, [])).content).toBe("恢复成功");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("classifies exhausted body reads as transport rather than processing errors", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.error(networkError("UND_ERR_BODY_TIMEOUT"));
    } })));
    await expect(new HttpLeaderModel({ ...config, fetchImpl: fetcher }).complete(messages, [])).rejects.toMatchObject({
      diagnostic: { category: "transport", transportPhase: "response_body", causeCode: "UND_ERR_BODY_TIMEOUT", attempts: 3 },
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("does not start a retry that cannot fit the remaining completion budget", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => { throw networkError("ECONNRESET"); });
    await expect(new HttpLeaderModel({ ...config, fetchImpl: fetcher, timeoutMs: 20, retryDelayMs: 30 }).complete(messages, [])).rejects.toMatchObject({
      message: expect.stringContaining("retry exceeds request budget"), diagnostic: { category: "transport", attempts: 1 },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("uses bounded exponential backoff and stops on abort during retry delay", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const abort = new AbortController();
    const fetcher = vi.fn<typeof fetch>(async () => { throw networkError("ECONNRESET"); });
    const pending = new HttpLeaderModel({ ...config, fetchImpl: fetcher, retryDelayMs: 100 }).complete(messages, [], abort.signal);
    const assertion = expect(pending).rejects.toThrow("stop now");
    await vi.advanceTimersByTimeAsync(99);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(199);
    expect(fetcher).toHaveBeenCalledTimes(2);
    abort.abort(new Error("stop now"));
    await assertion;
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps the original deadline across recovered attempts", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(networkError("ECONNRESET"))
      .mockImplementationOnce(async () => new Response(new ReadableStream<Uint8Array>()));
    const pending = new HttpLeaderModel({ ...config, fetchImpl: fetcher, timeoutMs: 100, retryDelayMs: 60 }).complete(messages, []);
    const assertion = expect(pending).rejects.toMatchObject({ diagnostic: { category: "timeout" } });
    await vi.advanceTimersByTimeAsync(60);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(40);
    await assertion;
  });

  it.each(["ENOTFOUND", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID", "ERR_INVALID_URL"])("does not retry permanent %s failures", async code => {
    const fetcher = vi.fn<typeof fetch>(async () => { throw networkError(code); });
    await expect(new HttpLeaderModel({ ...config, fetchImpl: fetcher }).complete(messages, [])).rejects.toMatchObject({
      diagnostic: { category: "transport", causeCode: code, attempts: 1 },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not retry arbitrary TypeErrors, invalid JSON, size violations, or provider quota failures", async () => {
    const cases = [
      vi.fn<typeof fetch>(async () => { throw new TypeError("Invalid request headers private-key"); }),
      vi.fn<typeof fetch>(async () => new Response("invalid json")),
      vi.fn<typeof fetch>(async () => new Response("x".repeat(1000))),
      vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: { type: "insufficient_quota", code: "provider_custom_code" } }),
        { status: 429, headers: { "content-type": "application/json" } })),
      vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: { type: "insufficient_quota", code: "server_error" } }),
        { status: 429, headers: { "content-type": "application/json" } })),
    ];
    for (const fetcher of cases) {
      await expect(new HttpLeaderModel({ ...config, fetchImpl: fetcher, maxResponseBytes: 256 }).complete(messages, [])).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it("never retries an externally cancelled in-flight fetch", async () => {
    const abort = new AbortController();
    const fetcher = vi.fn<typeof fetch>(async () => { abort.abort(new Error("cancel request")); throw networkError("ECONNRESET"); });
    await expect(new HttpLeaderModel({ ...config, fetchImpl: fetcher }).complete(messages, [], abort.signal)).rejects.toThrow("cancel request");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not retry or expose an unknown machine code", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => { throw networkError("private-key-unknown-code"); });
    const failure = await new HttpLeaderModel({ ...config, fetchImpl: fetcher }).complete(messages, []).catch(error => error);
    expect(modelDiagnostic(failure)).toEqual({ category: "transport", transportPhase: "fetch", attempts: 1 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(failure)).not.toContain("private-key");
  });

  it("stops a body read immediately on external cancellation without retrying", async () => {
    const abort = new AbortController();
    const cancel = vi.fn(async () => {});
    const fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({
      pull() { abort.abort(new Error("cancel body read")); }, cancel,
    })));
    await expect(new HttpLeaderModel({ ...config, fetchImpl: fetcher }).complete(messages, [], abort.signal)).rejects.toThrow("cancel body read");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("recovers a real HTTP connection closed partway through a 200 response", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let requests = 0;
    const server: Server = createServer((request, response) => {
      request.resume();
      requests++;
      if (requests === 1) {
        response.writeHead(200, { "content-type": "application/json", "content-length": String(replyBody.length + 500) });
        response.write('{"status":"completed",');
        setImmediate(() => response.destroy());
      } else response.end(replyBody);
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    try {
      const address = server.address();
      if (typeof address !== "object" || address === null) throw new Error("Missing test server address");
      const result = await new HttpLeaderModel({ ...config, baseUrl: `http://127.0.0.1:${address.port}/v1` }).complete(messages, []);
      expect(result.content).toBe("恢复成功");
      expect(requests).toBe(2);
      expect(warn).toHaveBeenCalledWith("Leader model temporary transport failure; retry scheduled", expect.objectContaining({
        category: "transport", transportPhase: "response_body", causeCode: "UND_ERR_SOCKET", attempts: 1,
      }));
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
