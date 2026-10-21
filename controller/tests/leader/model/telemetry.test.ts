import { afterEach, describe, expect, it, vi } from "vitest";
import { createMessageTrace, runWithTrace } from "../../../src/runtime/telemetry.js";
import { HttpLeaderModel } from "../../../src/leader/model/client.js";

const config = { baseUrl: "https://private-provider.example/v1", apiKey: "private-key", model: "test-model", retryDelayMs: 0 };
const messages = [{ role: "user" as const, content: "private-prompt" }];
const replyBody = JSON.stringify({ status: "completed", output: [{
  type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "private-answer" }],
}] });
afterEach(() => vi.restoreAllMocks());

describe("model timing", () => {
  it("associates each HTTP retry with one completion and separates headers/body/parse/backoff", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const events: Record<string, unknown>[] = [];
    const trace = createMessageTrace("private-chat", "private-message", event => events.push(event));
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "server_error", message: "private-provider-error" } }), {
        status: 503, headers: { "content-type": "application/json" },
      })).mockResolvedValueOnce(new Response(replyBody));
    const result = await runWithTrace(trace, () => new HttpLeaderModel({ ...config, fetchImpl: fetcher }).complete(messages, []));
    expect(result.content).toBe("private-answer");
    expect(events.every(event => event.traceId === trace.traceId && event.attemptId === trace.attemptId)).toBe(true);
    expect(new Set(events.map(event => event.completionId)).size).toBe(1);
    expect(events.filter(event => event.stage === "model.http.attempt.end")).toMatchObject([
      { attempt: 1, httpStatus: 503, outcome: "retry", durationMs: expect.any(Number) },
      { attempt: 2, httpStatus: 200, outcome: "ok", durationMs: expect.any(Number) },
    ]);
    const stages = events.map(event => event.stage);
    for (const stage of ["model.complete.end", "model.http.headers.end", "model.http.error_body.end",
      "model.http.backoff.end", "model.http.body.end", "model.http.parse.end"]) expect(stages).toContain(stage);
    const firstEnd = stages.indexOf("model.http.attempt.end");
    expect(firstEnd).toBeLessThan(stages.indexOf("model.http.backoff.start"));
    expect(JSON.stringify(events)).not.toMatch(/private-/);
  });

  it("closes transport failures and records safe final classification without error text", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const events: Record<string, unknown>[] = [];
    const trace = createMessageTrace("private-chat", "private-message", event => events.push(event));
    const fetcher = vi.fn<typeof fetch>(async () => { throw new TypeError("private-error", {
      cause: Object.assign(new Error("private-cause"), { code: "ECONNRESET" }),
    }); });
    await expect(runWithTrace(trace, () => new HttpLeaderModel({ ...config, fetchImpl: fetcher }).complete(messages, []))).rejects.toThrow();
    expect(events.filter(event => event.stage === "model.http.attempt.end")).toHaveLength(3);
    expect(events.find(event => event.stage === "model.failure")).toMatchObject({ category: "transport", attempt: 3, transportPhase: "fetch" });
    expect(events.at(-1)).toMatchObject({ stage: "model.complete.end", outcome: "error" });
    expect(JSON.stringify(events)).not.toMatch(/private-/);
  });
});
