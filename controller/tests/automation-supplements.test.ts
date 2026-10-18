import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AutomationService, CreateScheduleSchema, MemoryAutomationRepository, type AutomationSupplement } from "../src/automations/index.js";

const NOW = Date.parse("2026-10-18T01:00:00Z");
async function fixture() {
  const repository = new MemoryAutomationRepository();
  const service = new AutomationService({ repository, now: () => NOW, validateBackground: async () => undefined,
    runner: { start: async () => ({ status: "running" }), inspect: async () => ({ status: "running" }) } });
  const schedule = await service.create(CreateScheduleSchema.parse({ kind: "background", title: "monitor", timezone: "UTC",
    timing: { type: "at", at: new Date(NOW).toISOString() }, background: { prompt: "watch" } }),
  { chatId: "chat", currentMessageId: "user-message", explicitCurrentTurnAuthorization: true });
  const [{ run }] = await repository.claimDue(NOW, "owner", 1);
  const input: AutomationSupplement = { scheduleId: schedule.id, runId: run.id, chatId: "chat", invocationId: randomUUID(),
    kind: "failed", text: "A failed; B is still running", createdAt: NOW, expiresAt: NOW + 86_400_000 };
  return { repository, schedule, run, input };
}
describe("unified background supplement outbox", () => {
  it("persists a UUID supplement during execution without mutating run or schedule state", async () => {
    const f = await fixture();
    const beforeRun = await f.repository.listRuns(f.schedule.id, "chat");
    const beforeSchedule = await f.repository.get(f.schedule.id, "chat");
    const outbox = await f.repository.publishSupplement(f.input);
    expect(outbox.id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    expect(await f.repository.listRuns(f.schedule.id, "chat")).toEqual(beforeRun);
    expect(await f.repository.get(f.schedule.id, "chat")).toEqual(beforeSchedule);
    expect((await f.repository.pendingOutbox(NOW))[0].text).toBe(f.input.text);
  });
  it("deduplicates concurrent delivery attempts and rejects conflicting content", async () => {
    const f = await fixture();
    const items = await Promise.all([f.repository.publishSupplement(f.input), f.repository.publishSupplement(f.input)]);
    expect(items[0].id).toBe(items[1].id); expect(await f.repository.pendingOutbox(NOW)).toHaveLength(1);
    await expect(f.repository.publishSupplement({ ...f.input, text: "different" })).rejects.toThrow("conflicts");
  });
  it("checks exact chat, schedule and run ownership before append", async () => {
    const f = await fixture();
    await expect(f.repository.publishSupplement({ ...f.input, chatId: "other" })).rejects.toThrow("authorized");
    await expect(f.repository.publishSupplement({ ...f.input, runId: randomUUID() })).rejects.toThrow("authorized");
    await expect(f.repository.publishSupplement({ ...f.input, scheduleId: randomUUID() })).rejects.toThrow("authorized");
    expect(await f.repository.pendingOutbox(NOW)).toHaveLength(0);
  });
  it("preserves supplements when the final latest report supersedes prior base reports", async () => {
    const f = await fixture(); await f.repository.publishSupplement(f.input);
    await f.repository.finish(f.run.id, "owner", { status: "completed", result: { text: "final summary" } }, NOW);
    expect(await f.repository.pendingOutbox(NOW)).toHaveLength(2);
  });
  it("accepts followups for completed runs and never republishes an acknowledged delivery", async () => {
    const f = await fixture();
    await f.repository.finish(f.run.id, "owner", { status: "completed", result: { text: "initial" } }, NOW);
    const item = await f.repository.publishSupplement(f.input); await f.repository.markPublished(item.id);
    expect((await f.repository.publishSupplement(f.input)).status).toBe("published");
    expect((await f.repository.pendingOutbox(NOW)).map(row => row.id)).not.toContain(item.id);
  });
  it("refuses new supplements for cancelled schedules", async () => {
    const f = await fixture(); await f.repository.setStatus(f.schedule.id, "chat", "cancelled", NOW);
    await expect(f.repository.publishSupplement(f.input)).rejects.toThrow("Cancelled");
  });
  it("stores long results directly without formatting or truncating them in the scheduler", async () => {
    const f = await fixture(); const text = "跨机结果".repeat(25_000);
    await f.repository.publishSupplement({ ...f.input, text });
    expect((await f.repository.pendingOutbox(NOW))[0].text).toBe(text);
    expect((await f.repository.listRuns(f.schedule.id, "chat"))[0].status).toBe("dispatching");
  });
});
