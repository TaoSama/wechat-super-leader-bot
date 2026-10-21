import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMessageTrace, currentTrace, runWithTrace, traceEvent, traceSpan } from "../../src/runtime/telemetry.js";

afterEach(() => vi.restoreAllMocks());

describe("Controller message telemetry", () => {
  it("hashes the tuple identically to Gateway and validates only the parent attempt", async () => {
    const events: Record<string, unknown>[] = [];
    const parentAttemptId = randomUUID();
    const trace = createMessageTrace("private-chat", "private-message", event => events.push(event), parentAttemptId);
    await runWithTrace(trace, () => traceSpan("test.operation", async () => {
      await Promise.resolve();
      expect(currentTrace()).toBe(trace);
      traceEvent("test.safe", { inputChars: 10, text: "secret", token: "secret", chatId: "private-chat",
        messageId: "private-message", error: "private-error", durationMs: Number.NaN });
    }));
    expect(trace.traceId).toBe(createHash("sha256").update(JSON.stringify(["private-chat", "private-message"])).digest("hex"));
    expect(trace.attemptId).not.toBe(parentAttemptId);
    expect(events).toHaveLength(3);
    expect(events.every(event => event.service === "controller" && event.parentAttemptId === parentAttemptId)).toBe(true);
    expect(events[2]).toMatchObject({ outcome: "ok", durationMs: expect.any(Number) });
    expect(JSON.stringify(events)).not.toMatch(/private-chat|private-message|private-error|secret|NaN/);
    expect(createMessageTrace("a", "b", undefined, "malicious-header").parentAttemptId).toBeUndefined();
    expect(createMessageTrace("a", "b", undefined, [parentAttemptId] as unknown as string).parentAttemptId).toBeUndefined();
  });

  it("pairs failed spans without leaking thrown errors, and isolates simultaneous messages", async () => {
    const events: Record<string, unknown>[] = [];
    const traces = [createMessageTrace("a", "b", event => events.push(event)), createMessageTrace("c", "d", event => events.push(event))];
    await Promise.all(traces.map((trace, index) => runWithTrace(trace, async () => {
      await expect(traceSpan("test.operation", async () => {
        await new Promise(resolve => setTimeout(resolve, index));
        throw new Error("private-error");
      })).rejects.toThrow("private-error");
    })));
    for (const trace of traces) {
      const spans = events.filter(event => event.traceId === trace.traceId);
      expect(spans).toHaveLength(2);
      expect(spans[0].spanId).toBe(spans[1].spanId);
      expect(spans[1].outcome).toBe("error");
    }
    expect(JSON.stringify(events)).not.toContain("private-error");
    expect(currentTrace()).toBeUndefined();
  });

  it("does not let broken logging affect the action or error identity", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => { throw new Error("broken stderr"); });
    const trace = createMessageTrace("a", "b", () => { throw new Error("broken sink"); });
    expect(await runWithTrace(trace, () => traceSpan("test.operation", async () => "delivered"))).toBe("delivered");
    const failure = new Error("original");
    await expect(runWithTrace(trace, () => traceSpan("test.operation", async () => { throw failure; }))).rejects.toBe(failure);
  });
});
