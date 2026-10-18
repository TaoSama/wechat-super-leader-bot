import { describe, it, expect, vi } from "vitest";
import { AutomationService, MemoryAutomationRepository, CLAIM_LEASE_MS, type AutomationRunner, type CreateSchedule, type RunnerOutcome, executeAutomationTool } from "../src/automations/index.js";

const START = Date.parse("2026-10-18T00:00:00Z");
const authority = { chatId: "wx-user", currentMessageId: "user-message-1", explicitCurrentTurnAuthorization: true };
function fixture() {
  let now = START;
  const repository = new MemoryAutomationRepository();
  const runner: AutomationRunner = {
    start: vi.fn(async () => ({ status: "running", commandId: "cmd-1" })),
    inspect: vi.fn(async () => ({ status: "completed", result: { text: "report" } })),
  };
  const onError = vi.fn();
  const options = { repository, runner, now: () => now, onError,
    resolveTarget: async (nodeId: string, sessionId: string) => ({ nodeId, sessionId, sendRoute: "control-socket" as const }),
  };
  const service = new AutomationService(options);
  const session = (extra: Partial<CreateSchedule> = {}): CreateSchedule => ({ kind: "session", title: "report", timing: { type: "cron", expression: "* * * * *" },
    timezone: "Asia/Shanghai", prompt: "Inspect status", nodeId: "node-1", sessionId: "session-1", monitor: false, businessTtlMs: 86_400_000, retention: "latest", ...extra } as CreateSchedule);
  return { repository, runner, service, session, options, onError, now: () => now, advance: (ms: number) => { now += ms; } };
}

describe("persistent automation scheduling", () => {
  it("requires trusted current-turn authorization and discovers/fixes the exact session route", async () => {
    const f = fixture();
    await expect(f.service.create(f.session(), { ...authority, explicitCurrentTurnAuthorization: false })).rejects.toThrow("current user turn");
    const created = await f.service.create(f.session(), authority);
    expect(created.target).toEqual({ nodeId: "node-1", sessionId: "session-1", sendRoute: "control-socket" });
    expect(created.authorizedMessageId).toBe("user-message-1");
    const terminal = new AutomationService({ ...f.options, resolveTarget: async () => ({ nodeId: "node-1", sessionId: "session-1", sendRoute: "terminal-pane" }) });
    await expect(terminal.create(f.session(), { ...authority, currentMessageId: "another-user-message" })).rejects.toThrow("completion observation");
  });
  it("makes same-message creation idempotent across concurrent retries and restarts", async () => {
    const f = fixture();
    const results = await Promise.all([f.service.create(f.session(), authority), f.service.create(f.session(), authority)]);
    expect(results[0].id).toBe(results[1].id);
    expect(await f.repository.list(authority.chatId)).toHaveLength(1);
    f.advance(10 * 60_000);
    expect((await new AutomationService(f.options).create(f.session(), authority)).id).toBe(results[0].id);
    expect((await f.service.create(f.session(), { ...authority, currentMessageId: "new-message" })).id).not.toBe(results[0].id);
  });
  it("returns the original one-shot on replay even after its time passed", async () => {
    const f = fixture();
    const input = f.session({ timing: { type: "at", at: new Date(START + 60_000).toISOString() } });
    const original = await f.service.create(input, authority);
    f.advance(120_000);
    expect((await f.service.create(input, authority)).id).toBe(original.id);
    await expect(f.repository.create({ ...original, title: "different creation" })).rejects.toThrow("conflicts");
  });
  it("does not mark a paused or cancelled claim as successful execution", async () => {
    const f = fixture();
    const schedule = await f.service.create(f.session({ timing: { type: "at", at: new Date(START + 60_000).toISOString() } }), authority);
    f.advance(60_000);
    const originalClaim = f.repository.claimDue.bind(f.repository);
    let pauseOnce = true;
    f.repository.claimDue = async (...args) => {
      const claimed = await originalClaim(...args);
      if (pauseOnce) { pauseOnce = false; await f.repository.setStatus(schedule.id, authority.chatId, "paused", f.now()); }
      return claimed;
    };
    await f.service.tick();
    expect(f.runner.start).not.toHaveBeenCalled();
    expect((await f.repository.listRuns(schedule.id, authority.chatId))[0].status).toBe("skipped");
    expect(await f.repository.pendingOutbox(f.now())).toEqual([]);
    await f.repository.setStatus(schedule.id, authority.chatId, "active", f.now());
    await f.service.tick();
    expect(f.runner.start).toHaveBeenCalledTimes(1);
    expect((await f.repository.listRuns(schedule.id, authority.chatId))).toHaveLength(1);
  });
  it("validates timezone, cron precision and future one-shot time", async () => {
    const f = fixture();
    await expect(f.service.create(f.session({ timezone: "Mars/Olympus" }), authority)).rejects.toThrow("IANA");
    await expect(f.service.create(f.session({ timing: { type: "cron", expression: "* * * * * *" } }), authority)).rejects.toThrow("five fields");
    await expect(f.service.create(f.session({ timing: { type: "at", at: new Date(START).toISOString() } }), authority)).rejects.toThrow("future");
  });
  it("uses IANA local time including daylight-saving offset", async () => {
    const f = fixture();
    const schedule = await f.service.create(f.session({ timing: { type: "cron", expression: "0 9 * * *" }, timezone: "America/New_York" }), authority);
    expect(new Date(schedule.nextAt!).toISOString()).toBe("2026-10-18T13:00:00.000Z");
  });
  it("keeps reminders silent until due, persists result and outbox without calling an agent", async () => {
    const f = fixture();
    const created = await f.service.create({ kind: "reminder", title: "Reminder", text: "Drink water", timezone: "Asia/Shanghai",
      timing: { type: "at", at: new Date(START + 60_000).toISOString() }, businessTtlMs: 60_000, retention: "latest" }, authority);
    await f.service.tick();
    expect(await f.repository.pendingOutbox(f.now())).toEqual([]);
    f.advance(60_000); await f.service.tick(); await f.service.tick();
    expect(f.runner.start).not.toHaveBeenCalled();
    expect((await f.repository.listRuns(created.id, authority.chatId))).toHaveLength(1);
    expect((await f.repository.get(created.id, authority.chatId))?.status).toBe("completed");
    expect((await f.repository.pendingOutbox(f.now()))[0].text).toBe("Drink water");
  });
  it("atomically claims each occurrence across instances and never overlaps one schedule", async () => {
    const f = fixture();
    const created = await f.service.create(f.session(), authority);
    const other = new AutomationService(f.options);
    f.advance(60_000);
    await Promise.all([f.service.tick(), other.tick()]);
    expect(f.runner.start).toHaveBeenCalledTimes(1);
    f.runner.inspect = vi.fn(async () => ({ status: "running", commandId: "cmd-1" }));
    f.advance(5 * 60_000); await Promise.all([f.service.tick(), other.tick()]);
    expect(f.runner.start).toHaveBeenCalledTimes(1);
    expect((await f.repository.listRuns(created.id, authority.chatId))).toHaveLength(1);
  });
  it("coalesces missed cron triggers to the newest occurrence", async () => {
    const f = fixture();
    const created = await f.service.create(f.session(), authority);
    f.advance(5 * 60_000 + 5_000); await f.service.tick();
    const runs = await f.repository.listRuns(created.id, authority.chatId);
    expect(runs).toHaveLength(1);
    expect(runs[0].scheduledAt).toBe(START + 5 * 60_000);
    expect((await f.repository.get(created.id, authority.chatId))?.nextAt).toBe(START + 6 * 60_000);
  });
  it("expires an old one-shot by business TTL instead of sending stale content", async () => {
    const f = fixture();
    const created = await f.service.create(f.session({ timing: { type: "at", at: new Date(START + 60_000).toISOString() }, businessTtlMs: 1_000 }), authority);
    f.advance(62_000); await f.service.tick();
    expect(f.runner.start).not.toHaveBeenCalled();
    expect((await f.repository.listRuns(created.id, authority.chatId))[0].status).toBe("expired");
    expect(await f.repository.pendingOutbox(f.now())).toEqual([]);
  });
  it("a restart with a dispatching claim becomes unknown and cannot redispatch", async () => {
    const f = fixture();
    const created = await f.service.create(f.session(), authority);
    f.advance(60_000);
    await f.repository.claimDue(f.now(), "dead-worker", 20);
    f.runner.inspect = vi.fn(async () => ({ status: "unknown", error: "No durable command receipt exists" }));
    f.advance(CLAIM_LEASE_MS + 1);
    await new AutomationService(f.options).tick();
    expect(f.runner.start).not.toHaveBeenCalled();
    expect((await f.repository.listRuns(created.id, authority.chatId))[0].status).toBe("unknown");
    f.advance(10 * 60_000); await f.service.tick();
    expect(f.runner.start).not.toHaveBeenCalled();
  });
  it("recovers a persisted command by immutable request ID after crashing before saving its receipt", async () => {
    const f = fixture();
    const created = await f.service.create(f.session({ timing: { type: "at", at: new Date(START + 60_000).toISOString() } }), authority);
    f.advance(60_000);
    const [claimed] = await f.repository.claimDue(f.now(), "crashed-before-receipt", 20);
    const durableCommands = new Map([[claimed.run.id, { status: "completed" as const, result: { text: "persisted command output" } }]]);
    f.runner.inspect = vi.fn(async run => durableCommands.get(run.id) ?? { status: "unknown", error: "No command" });
    f.advance(CLAIM_LEASE_MS + 1); await new AutomationService(f.options).tick();
    expect(f.runner.start).not.toHaveBeenCalled(); expect(f.runner.inspect).toHaveBeenCalledTimes(1);
    expect((await f.repository.listRuns(created.id, authority.chatId))[0].status).toBe("completed");
    expect((await f.repository.pendingOutbox(f.now()))[0].text).toBe("persisted command output");
  });
  it("rejects expired and replaced owners' late writes", async () => {
    const f = fixture(); const created = await f.service.create(f.session(), authority);
    f.advance(60_000); const [claimed] = await f.repository.claimDue(f.now(), "old-owner", 20);
    f.advance(CLAIM_LEASE_MS);
    expect(await f.repository.finish(claimed.run.id, "old-owner", { status: "completed", result: { text: "late" } }, f.now())).toBe(false);
    const [reclaimed] = await f.repository.claimRunning(f.now(), "new-owner", 20);
    expect(reclaimed.run.id).toBe(claimed.run.id);
    expect(await f.repository.finish(claimed.run.id, "old-owner", { status: "completed", result: { text: "stale owner" } }, f.now())).toBe(false);
    expect(await f.repository.finish(claimed.run.id, "new-owner", { status: "completed", result: { text: "observed" } }, f.now())).toBe(true);
    expect((await f.repository.listRuns(created.id, authority.chatId))[0].result?.text).toBe("observed");
  });
  it("rechecks current authorization after async discovery and before status mutation", async () => {
    const f = fixture(); let revoked = false;
    const service = new AutomationService({ ...f.options, resolveTarget: async (nodeId, sessionId) => { revoked = true; return { nodeId, sessionId, sendRoute: "control-socket" }; } });
    const auth = { ...authority, assertCurrentAuthority: async () => { if (revoked) throw new Error("Authority revoked"); } };
    await expect(service.create(f.session(), auth)).rejects.toThrow("revoked");
    expect(await f.repository.list(authority.chatId)).toEqual([]);
    const schedule = await f.service.create(f.session(), authority);
    await expect(executeAutomationTool(f.service, "update_automation", { id: schedule.id, status: "cancelled" }, auth, f.now())).rejects.toThrow("revoked");
    expect((await f.repository.get(schedule.id, authority.chatId))?.status).toBe("active");
    await expect(f.service.create(f.session(), auth)).rejects.toThrow("revoked");
  });
  it("treats unclassified dispatch failures as unknown rather than retrying execution", async () => {
    const f = fixture();
    const created = await f.service.create(f.session(), authority);
    f.runner.start = vi.fn(async () => { throw new Error("socket closed after submit"); });
    f.advance(60_000); await f.service.tick();
    f.advance(5 * 60_000); await f.service.tick();
    expect(f.runner.start).toHaveBeenCalledTimes(1);
    expect(f.onError).toHaveBeenCalledTimes(1);
    expect((await f.repository.listRuns(created.id, authority.chatId))[0].status).toBe("unknown");
  });
  it("persists inspection outages and retries only observation without redispatch", async () => {
    const f = fixture();
    const schedule = await f.service.create(f.session({ timing: { type: "at", at: new Date(START + 60_000).toISOString() } }), authority);
    f.advance(60_000); await f.service.tick();
    f.runner.inspect = vi.fn(async () => { throw new Error("temporary offline"); });
    await f.service.tick();
    const interrupted = (await f.repository.listRuns(schedule.id, authority.chatId))[0];
    expect(interrupted.status).toBe("running"); expect(interrupted.error).toContain("Inspection temporarily failed");
    f.runner.inspect = vi.fn(async () => ({ status: "completed", result: { text: "recovered output" } }));
    await f.service.tick();
    const completed = (await f.repository.listRuns(schedule.id, authority.chatId))[0];
    expect(completed.status).toBe("completed"); expect(completed.error).toBeUndefined();
    expect(f.runner.start).toHaveBeenCalledTimes(1);
  });
  it("persists completed output before delivery and retrying publication does not rerun the task", async () => {
    const f = fixture();
    const created = await f.service.create(f.session({ timing: { type: "at", at: new Date(START + 60_000).toISOString() } }), authority);
    f.advance(60_000); await f.service.tick();
    await f.service.tick();
    const outbox = await f.repository.pendingOutbox(f.now());
    expect(outbox).toHaveLength(1);
    expect((await f.repository.listRuns(created.id, authority.chatId))[0].result?.text).toBe("report");
    await f.service.tick();
    expect(await f.repository.pendingOutbox(f.now())).toEqual(outbox);
    expect(f.runner.start).toHaveBeenCalledTimes(1);
    await f.repository.markPublished(outbox[0].id);
    expect(await f.repository.pendingOutbox(f.now())).toEqual([]);
  });
  it("suppresses unchanged monitoring output and emits changed, failed and recovered states", async () => {
    const f = fixture();
    const created = await f.service.create(f.session({ monitor: true, retention: "retain" }), authority);
    let outcome: RunnerOutcome = { status: "completed", result: { text: "healthy", fingerprint: "healthy" } };
    f.runner.start = vi.fn(async () => outcome);
    const tick = async () => { f.advance(60_000); await f.service.tick(); };
    await tick(); await tick();
    expect(await f.repository.pendingOutbox(f.now())).toHaveLength(1);
    outcome = { status: "failed", result: { text: "service is down", fingerprint: "down" } };
    await tick(); await tick();
    outcome = { status: "completed", result: { text: "healthy again", fingerprint: "healthy", meaningful: false } };
    await tick();
    expect((await f.repository.pendingOutbox(f.now())).map(item => item.kind)).toEqual(["completed", "failed", "recovered"]);
    expect(await f.repository.listRuns(created.id, authority.chatId)).toHaveLength(5);
  });
  it("replaces pending latest reports but preserves every execution result", async () => {
    const f = fixture();
    const created = await f.service.create(f.session(), authority);
    let count = 0;
    f.runner.start = vi.fn(async () => ({ status: "completed", result: { text: `report ${++count}` } }));
    f.advance(60_000); await f.service.tick(); f.advance(60_000); await f.service.tick();
    expect((await f.repository.pendingOutbox(f.now())).map(item => item.text)).toEqual(["report 2"]);
    expect(await f.repository.listRuns(created.id, authority.chatId)).toHaveLength(2);
  });
  it("limits changes to the owning chat and respects pause/resume/cancel", async () => {
    const f = fixture();
    const created = await f.service.create(f.session(), authority);
    expect(await f.repository.get(created.id, "other-chat")).toBeNull();
    expect(await f.repository.setStatus(created.id, "other-chat", "cancelled", f.now())).toBeNull();
    await f.repository.setStatus(created.id, authority.chatId, "paused", f.now());
    f.advance(60_000); await f.service.tick(); expect(f.runner.start).not.toHaveBeenCalled();
    await f.repository.setStatus(created.id, authority.chatId, "active", f.now());
    await f.service.tick(); expect(f.runner.start).toHaveBeenCalledTimes(1);
    await f.repository.setStatus(created.id, authority.chatId, "cancelled", f.now());
    await f.service.tick();
    expect(await f.repository.pendingOutbox(f.now())).toEqual([]);
    await expect(f.repository.setStatus(created.id, authority.chatId, "active", f.now())).rejects.toThrow("Finished");
  });
});
