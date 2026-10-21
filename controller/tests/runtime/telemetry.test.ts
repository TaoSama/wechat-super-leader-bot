import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
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
    vi.spyOn(fs, "writeSync").mockImplementation(() => { throw new Error("broken stderr"); });
    const trace = createMessageTrace("a", "b", () => { throw new Error("broken sink"); });
    expect(await runWithTrace(trace, () => traceSpan("test.operation", async () => "delivered"))).toBe("delivered");
    const failure = new Error("original");
    await expect(runWithTrace(trace, () => traceSpan("test.operation", async () => { throw failure; }))).rejects.toBe(failure);
  });
});


for (const closedStderr of [false, true]) {
  it(`keeps stdout machine-readable${closedStderr ? " with a closed stderr descriptor" : " while logging JSON to stderr"}`, () => {
    const moduleUrl = new URL("../../src/runtime/telemetry.js", import.meta.url);
    if (!fs.existsSync(moduleUrl)) moduleUrl.pathname = moduleUrl.pathname.replace(/\.js$/, ".ts");
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", `
      import fs from "node:fs";
      import { createMessageTrace, runWithTrace, traceSpan } from ${JSON.stringify(moduleUrl.href)};
      if (${closedStderr}) fs.closeSync(2);
      const trace = createMessageTrace("chat", "message");
      let result;
      let originalErrorPreserved = false;
      await runWithTrace(trace, async () => {
        result = await traceSpan("success", async () => "accepted");
        const original = new Error("private-action-failure");
        try { await traceSpan("failure", async () => { throw original; }); }
        catch (error) { if (error !== original) throw error; originalErrorPreserved = true; }
      });
      process.stdout.write(JSON.stringify({ result, originalErrorPreserved }));
    `], { encoding: "utf8", timeout: 5000 });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(child.signal).toBeNull();
    expect(JSON.parse(child.stdout)).toEqual({ result: "accepted", originalErrorPreserved: true });
    if (closedStderr) expect(child.stderr).toBe("");
    else {
      const events = child.stderr.trim().split("\n").map(line => JSON.parse(line));
      expect(events.map(event => event.stage)).toEqual(["success.start", "success.end", "failure.start", "failure.end"]);
      expect(events.every(event => event.service === "controller")).toBe(true);
      expect(child.stderr).not.toContain("private-action-failure");
    }
  });
}
