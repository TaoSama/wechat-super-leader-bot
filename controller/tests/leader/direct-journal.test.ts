import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { DirectCallSchema, type DirectCall, type LegacyDirectAuthorization } from "../../src/leader/direct-contracts.js";
import { DirectToolJournal } from "../../src/leader/direct-journal.js";
import { MemoryStore } from "../../src/store/memory.js";

const RESULT = { result: { commandId: "command", status: "accepted" } };
const request = (overrides: Partial<DirectCall> = {}): DirectCall => DirectCallSchema.parse({
  chatId: "chat", messageId: "message", text: "让会话检查提交", callId: "call", name: "execute_plan",
  arguments: { target: "session", prompt: "检查提交" }, ...overrides,
});
const LEGACY_ATTESTATION: LegacyDirectAuthorization = { intent: "task", automationOperations: [], backgroundOperations: [], sendImages: false,
  interruptSession: false, approvalDecision: "none", memoryOperations: [] };
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
// Frozen copy of the earlier record format, whose fingerprint also hashed the attestation.
function legacyFingerprint(call: DirectCall, effectKey: string): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => [key, canonical(item)])) : value;
  return sha(canonical([call.text, call.name, call.arguments, LEGACY_ATTESTATION, effectKey]));
}
function fixture() {
  const store = new MemoryStore();
  const journal = new DirectToolJournal(store, () => true);
  const action = vi.fn(async () => RESULT);
  return { store, journal, action };
}

describe("direct tool durable journal", () => {
  it("replays a completed call after restarting the journal without executing it again", async () => {
    const f = fixture();
    expect(await f.journal.call(request(), f.action, "dispatch")).toEqual(RESULT);
    const restarted = new DirectToolJournal(f.store, () => true);
    expect(await restarted.call(request(), f.action, "dispatch")).toEqual(RESULT);
    expect(f.action).toHaveBeenCalledTimes(1);
  });

  it("binds a turn to the exact original human text across different call IDs", async () => {
    const f = fixture();
    await f.journal.bind(request());
    await expect(f.journal.call(request({ callId: "next", text: "改成删除项目" }), f.action, "dispatch"))
      .rejects.toMatchObject({ code: "MESSAGE_REBOUND" });
    expect(f.action).not.toHaveBeenCalled();
  });

  it("rejects a turn that disagrees with an existing original message", async () => {
    const f = fixture();
    await f.store.recordMessage({ chatId: "chat", messageId: "message", text: "仅查询状态", replyText: "状态",
      createdAt: new Date().toISOString() });
    await expect(f.journal.call(request(), f.action, "dispatch")).rejects.toMatchObject({ code: "MESSAGE_REBOUND" });
    expect(f.action).not.toHaveBeenCalled();
  });

  it("reuses the completed effect under a new call ID and persists that call result", async () => {
    const f = fixture();
    await f.journal.call(request(), f.action, "dispatch");
    const second = request({ callId: "second" });
    expect(await new DirectToolJournal(f.store, () => true).call(second, f.action, "dispatch")).toEqual(RESULT);
    expect(await new DirectToolJournal(f.store, () => true).call(second, f.action, "dispatch")).toEqual(RESULT);
    expect(f.action).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "execute_goal" },
    { arguments: { target: "other", prompt: "检查提交" } },
  ])("rejects changed content behind a shared effect key: %j", async overrides => {
    const f = fixture();
    await f.journal.call(request(), f.action, "dispatch");
    await expect(f.journal.call(request({ callId: "second", ...overrides }), f.action, "dispatch"))
      .rejects.toMatchObject({ code: "EFFECT_ALREADY_SUBMITTED" });
    expect(f.action).toHaveBeenCalledTimes(1);
  });

  it("ignores a legacy attestation when fingerprinting a call", async () => {
    const f = fixture();
    await f.journal.call(request(), f.action, "dispatch");
    const attested = request({ callId: "second", authorization: { ...LEGACY_ATTESTATION, intent: "goal" } });
    expect(await f.journal.call(attested, f.action, "dispatch")).toEqual(RESULT);
    expect(f.action).toHaveBeenCalledTimes(1);
  });

  it("matches records written while the attestation was part of the fingerprint", async () => {
    const f = fixture();
    const legacy = request({ authorization: LEGACY_ATTESTATION });
    await f.journal.bind(legacy);
    await f.store.recordMessage({ chatId: "chat", messageId: `direct_effect_done_${sha(["message", "dispatch"])}`,
      text: legacyFingerprint(legacy, "dispatch"), replyText: JSON.stringify(RESULT), createdAt: new Date().toISOString() });
    expect(await f.journal.call({ ...legacy, callId: "retry" }, f.action, "dispatch")).toEqual(RESULT);
    expect(f.action).not.toHaveBeenCalled();
  });

  it("canonicalizes nested object keys but preserves argument array order", async () => {
    const f = fixture();
    const original = request({ arguments: { nested: { first: 1, second: 2 }, actions: [1, 2] } });
    await f.journal.call(original, f.action, "dispatch");
    const reordered = request({ callId: "second", arguments: { actions: [1, 2], nested: { second: 2, first: 1 } } });
    expect(await f.journal.call(reordered, f.action, "dispatch")).toEqual(RESULT);
    await expect(f.journal.call({ ...reordered, callId: "third", arguments: { nested: { first: 1, second: 2 }, actions: [2, 1] } },
      f.action, "dispatch")).rejects.toMatchObject({ code: "EFFECT_ALREADY_SUBMITTED" });
    expect(f.action).toHaveBeenCalledTimes(1);
  });

  it("rejects reuse of a call ID with changed content or a changed effect key", async () => {
    const f = fixture();
    await f.journal.call(request(), f.action, "dispatch");
    await expect(f.journal.call(request({ arguments: {} }), f.action, "dispatch")).rejects.toMatchObject({ code: "CALL_ID_REUSED" });
    await expect(f.journal.call(request(), f.action, "other-effect")).rejects.toMatchObject({ code: "CALL_ID_REUSED" });
    expect(f.action).toHaveBeenCalledTimes(1);
  });

  it("does not redispatch an interrupted effect when the caller changes its call ID", async () => {
    const f = fixture();
    const failed = vi.fn(async () => { throw new Error("connection lost after submission"); });
    await expect(f.journal.call(request(), failed, "dispatch")).rejects.toThrow("connection lost");
    const restarted = new DirectToolJournal(f.store, () => true);
    await expect(restarted.call(request({ callId: "second" }), f.action, "dispatch")).rejects.toThrow("已经开始过");
    await expect(restarted.call(request(), f.action, "dispatch")).rejects.toThrow("已经开始过");
    expect(failed).toHaveBeenCalledTimes(1);
    expect(f.action).not.toHaveBeenCalled();
  });

  it("recovers the same call when its effect result survived but saving the call result failed", async () => {
    const f = fixture();
    const recordMessage = f.store.recordMessage.bind(f.store);
    let failOnce = true;
    vi.spyOn(f.store, "recordMessage").mockImplementation(async message => {
      if (failOnce && message.messageId.startsWith("direct_done_")) {
        failOnce = false;
        throw new Error("call receipt storage unavailable");
      }
      await recordMessage(message);
    });
    await expect(f.journal.call(request(), f.action, "dispatch")).rejects.toThrow("receipt storage unavailable");
    expect(await new DirectToolJournal(f.store, () => true).call(request(), f.action, "dispatch")).toEqual(RESULT);
    expect(f.action).toHaveBeenCalledTimes(1);
  });

  it("elects one durable effect owner across two independent instances", async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let signalStarted!: () => void;
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    const firstAction = vi.fn(async () => { signalStarted(); await gate; return RESULT; });
    const first = f.journal.call(request(), firstAction, "dispatch");
    await started;
    const second = new DirectToolJournal(f.store, () => true);
    await expect(second.call(request({ callId: "second" }), f.action, "dispatch")).rejects.toThrow("已经开始过");
    release();
    expect(await first).toEqual(RESULT);
    expect(firstAction).toHaveBeenCalledTimes(1);
    expect(f.action).not.toHaveBeenCalled();
  });

  it("coalesces a concurrent replay of the same call in one instance", async () => {
    const f = fixture();
    const calls = [f.journal.call(request(), f.action, "dispatch"), f.journal.call(request(), f.action, "dispatch")];
    expect(await Promise.all(calls)).toEqual([RESULT, RESULT]);
    expect(f.action).toHaveBeenCalledTimes(1);
  });

  it("keeps failed reads retryable while caching successful call results", async () => {
    const f = fixture();
    const read = request({ name: "list_sessions", arguments: {} });
    const failed = vi.fn(async () => { throw new Error("temporarily unavailable"); });
    await expect(f.journal.call(read, failed)).rejects.toThrow("temporarily unavailable");
    expect(await new DirectToolJournal(f.store, () => true).call(read, f.action)).toEqual(RESULT);
    expect(await f.journal.call(read, f.action)).toEqual(RESULT);
    expect(f.action).toHaveBeenCalledTimes(1);
    await f.journal.call({ ...read, callId: "fresh-read" }, f.action);
    expect(f.action).toHaveBeenCalledTimes(2);
  });

  it("scopes an effect to its human turn and chat", async () => {
    const f = fixture();
    await f.journal.call(request(), f.action, "dispatch");
    await f.journal.call(request({ messageId: "other-message" }), f.action, "dispatch");
    await f.journal.call(request({ chatId: "other-chat" }), f.action, "dispatch");
    expect(f.action).toHaveBeenCalledTimes(3);
  });

  it("checks the chat allowlist even when replaying a completed effect", async () => {
    const f = fixture();
    await f.journal.call(request(), f.action, "dispatch");
    const denied = new DirectToolJournal(f.store, () => false);
    await expect(denied.call(request({ callId: "second" }), f.action, "dispatch")).rejects.toThrow("CHAT_NOT_ALLOWED");
    expect(f.action).toHaveBeenCalledTimes(1);
  });
});
