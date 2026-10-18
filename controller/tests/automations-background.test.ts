import { describe, expect, it, vi } from "vitest";
import { AutomationService, BACKGROUND_IMMEDIATE_TOLERANCE_MS, CreateScheduleSchema, MemoryAutomationRepository,
  type AutomationRunner, type CreateSchedule } from "../src/automations/index.js";

const NOW = Date.parse("2026-10-18T01:00:00Z");
const authority = { chatId: "chat", currentMessageId: "user-message", explicitCurrentTurnAuthorization: true };
const input = (at = NOW): CreateSchedule => CreateScheduleSchema.parse({ kind: "background", title: "跨机器结果监控",
  timing: { type: "at", at: new Date(at).toISOString() }, timezone: "Asia/Shanghai", background: { prompt: "收齐结果后比较差异" } });
function fixture() {
  const repository = new MemoryAutomationRepository();
  const runner: AutomationRunner = { start: vi.fn(async () => ({ status: "completed", result: { text: "summary" } })),
    inspect: vi.fn(async () => ({ status: "completed", result: { text: "recovered" } })) };
  const validateBackground = vi.fn(async () => undefined);
  const onFinished = vi.fn(async () => undefined);
  const onError = vi.fn();
  const options = { repository, runner, validateBackground, onFinished, onError, now: () => NOW };
  return { repository, runner, validateBackground, onFinished, onError, options, service: new AutomationService(options) };
}
describe("background schedules on the unified automation ledger", () => {
  it("requires the background capability and enforces its current creation authority", async () => {
    const f = fixture();
    await expect(new AutomationService({ repository: f.repository, runner: f.runner, now: () => NOW }).create(input(), authority)).rejects.toThrow("unavailable");
    const schedule = await f.service.create(input(), authority);
    expect(schedule.kind).toBe("background"); expect(schedule.target).toBeUndefined();
    expect(f.validateBackground).toHaveBeenCalledWith(expect.objectContaining({ prompt: "收齐结果后比较差异" }), authority);
    f.validateBackground.mockRejectedValueOnce(new Error("execution disabled"));
    await expect(f.service.create(input(), { ...authority, currentMessageId: "another" })).rejects.toThrow("execution disabled");
    expect(await f.repository.list("chat")).toHaveLength(1);
  });
  it("accepts immediate starts up to five minutes late while preserving the original scheduled occurrence", async () => {
    const f = fixture(); const plannedAt = NOW - BACKGROUND_IMMEDIATE_TOLERANCE_MS;
    const schedule = await f.service.create(input(plannedAt), authority);
    expect(schedule.nextAt).toBe(plannedAt);
    await f.service.tick();
    const [run] = await f.repository.listRuns(schedule.id, "chat");
    expect(run.scheduledAt).toBe(plannedAt); expect(run.status).toBe("completed");
    expect(f.runner.start).toHaveBeenCalledTimes(1);
    await expect(f.service.create(input(plannedAt - 1), { ...authority, currentMessageId: "old" })).rejects.toThrow("five-minute");
  });
  it("deduplicates nested specs and rejects conflicting persisted creation requests", async () => {
    const f = fixture(); const schedule = await f.service.create(input(), authority);
    expect((await f.service.create(input(), authority)).id).toBe(schedule.id);
    if (schedule.kind !== "background") throw new Error("Expected background schedule");
    await expect(f.repository.create({ ...schedule, background: { ...schedule.background, prompt: "other" } })).rejects.toThrow("conflicts");
  });
  it("calls onFinished after the result and outbox commit", async () => {
    const f = fixture();
    f.onFinished.mockImplementation(async () => {
      expect((await f.repository.pendingOutbox(NOW))[0].text).toBe("summary");
    });
    const schedule = await f.service.create(input(), authority); await f.service.tick();
    expect(f.onFinished).toHaveBeenCalledWith(expect.objectContaining({ scheduleId: schedule.id }), expect.objectContaining({ id: schedule.id }),
      { status: "completed", result: { text: "summary" } });
  });
  it("does not overwrite a completed run or invoke finish twice when post-commit work fails", async () => {
    const f = fixture();
    f.onFinished.mockRejectedValue(new Error("acceptance unavailable"));
    const finish = vi.spyOn(f.repository, "finish");
    const schedule = await f.service.create(input(), authority); await f.service.tick();
    expect(finish).toHaveBeenCalledTimes(1);
    expect((await f.repository.listRuns(schedule.id, "chat"))[0].status).toBe("completed");
    expect(f.onError).toHaveBeenCalledWith(expect.any(Error), expect.stringContaining("post-commit"));
    await f.service.tick(); expect(f.runner.start).toHaveBeenCalledTimes(1);
  });
  it("keeps an inspection completion durable when its post-commit hook fails", async () => {
    const f = fixture();
    f.runner.start = vi.fn(async () => ({ status: "running" }));
    const schedule = await f.service.create(input(), authority); await f.service.tick();
    f.onFinished.mockRejectedValue(new Error("hook failed"));
    const finish = vi.spyOn(f.repository, "finish"); await f.service.tick();
    expect(finish).toHaveBeenCalledTimes(1);
    expect((await f.repository.listRuns(schedule.id, "chat"))[0]).toMatchObject({ status: "completed", result: { text: "recovered" } });
  });
  it("does not call post-commit hooks after a lost lease rejects finish", async () => {
    const f = fixture(); await f.service.create(input(), authority);
    vi.spyOn(f.repository, "finish").mockResolvedValue(false);
    await f.service.tick(); expect(f.onFinished).not.toHaveBeenCalled();
  });
});
