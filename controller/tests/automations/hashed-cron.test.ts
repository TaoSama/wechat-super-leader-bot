import { CronExpressionParser } from "cron-parser";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutomationRunner, CreateSchedule, Schedule } from "../../src/automations/contracts.js";
import { MemoryAutomationRepository } from "../../src/automations/memory.js";
import { AutomationService } from "../../src/automations/service.js";
import { dueOccurrence, validateTiming } from "../../src/automations/timing.js";

const START = Date.parse("2026-10-23T00:00:00Z");
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const SCHEDULE_ID = "persisted-hashed-cron";
const authority = { chatId: "user", currentMessageId: "turn", explicitCurrentTurnAuthorization: true };
const input: CreateSchedule = { kind: "reminder", title: "Hourly reminder", text: "hello",
  timing: { type: "cron", expression: "H * * * *" }, timezone: "UTC", businessTtlMs: HOUR_MS, retention: "latest" };
const runner: AutomationRunner = {
  start: async () => { throw new Error("Reminder must not dispatch a model"); },
  inspect: async () => { throw new Error("Completed reminder must not be inspected"); },
};

function persistedSchedule(nextAt = validateTiming(input, START, SCHEDULE_ID)): Schedule {
  return { ...input, id: SCHEDULE_ID, chatId: authority.chatId, authorizedMessageId: authority.currentMessageId,
    status: "active", nextAt, createdAt: START, updatedAt: START };
}

afterEach(() => vi.restoreAllMocks());

describe("hashed cron scheduling", () => {
  it("uses the persisted identity for creation and every previous/next parse", () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.062);
    const createdAt = validateTiming(input, START, SCHEDULE_ID);
    const expected = CronExpressionParser.parse("H * * * *", { currentDate: new Date(START), tz: "UTC", hashSeed: SCHEDULE_ID }).next().getTime();
    expect(createdAt).toBe(expected);
    random.mockReturnValue(0.118);
    expect(validateTiming(input, START, SCHEDULE_ID)).toBe(createdAt);
    for (let minute = 0; minute < 60; minute++) {
      expect(dueOccurrence(persistedSchedule(createdAt), createdAt + minute * MINUTE_MS)).toEqual({
        scheduledAt: createdAt, nextAt: createdAt + HOUR_MS,
      });
    }
  });

  it("gives different persisted jobs their own stable seed", () => {
    const nextTimes = new Set(Array.from({ length: 24 }, (_, index) => validateTiming(input, START, `job-${index}`)));
    expect(nextTimes.size).toBeGreaterThan(1);
  });

  it("coalesces downtime on the same hashed plan, including expressions with multiple H fields", () => {
    const recurring = { ...input, timing: { type: "cron" as const, expression: "H H * * *" } };
    const firstAt = validateTiming(recurring, START, SCHEDULE_ID);
    const schedule = { ...persistedSchedule(firstAt), ...recurring };
    const now = firstAt + 3 * 24 * HOUR_MS + MINUTE_MS;
    expect(dueOccurrence(schedule, now)).toEqual({ scheduledAt: firstAt + 3 * 24 * HOUR_MS, nextAt: firstAt + 4 * 24 * HOUR_MS });
  });

  it("keeps one occurrence per hour after JSON persistence and service recreation", async () => {
    let now = START;
    let repository = new MemoryAutomationRepository();
    let service = new AutomationService({ repository, runner, now: () => now });
    const created = await service.create(input, authority);
    const firstAt = created.nextAt!;
    now = firstAt;
    vi.spyOn(Math, "random").mockReturnValue(0.118);
    await service.tick();
    expect(await repository.listRuns(created.id, authority.chatId)).toHaveLength(1);
    const serialized = JSON.stringify(await repository.get(created.id, authority.chatId));
    repository = new MemoryAutomationRepository();
    await repository.create(JSON.parse(serialized) as Schedule);
    service = new AutomationService({ repository, runner, now: () => now });
    vi.mocked(Math.random).mockReturnValue(0.82);
    for (let minute = 1; minute < 60; minute++) {
      now = firstAt + minute * MINUTE_MS;
      await service.tick();
    }
    expect(await repository.listRuns(created.id, authority.chatId)).toHaveLength(0);
    now = firstAt + HOUR_MS;
    await service.tick();
    const runs = await repository.listRuns(created.id, authority.chatId);
    expect(runs).toHaveLength(1);
    expect(runs[0].scheduledAt).toBe(firstAt + HOUR_MS);
    expect((await repository.get(created.id, authority.chatId))?.nextAt).toBe(firstAt + 2 * HOUR_MS);
  });

  it("preserves fixed cron wall-clock timing, including daylight-saving timezone conversion", () => {
    const fixed = { ...input, timing: { type: "cron" as const, expression: "0 9 * * *" }, timezone: "America/New_York" };
    const firstAt = validateTiming(fixed, START, SCHEDULE_ID);
    expect(new Date(firstAt).toISOString()).toBe("2026-10-23T13:00:00.000Z");
    const schedule = { ...persistedSchedule(firstAt), ...fixed };
    expect(dueOccurrence(schedule, firstAt + MINUTE_MS)).toEqual({ scheduledAt: firstAt, nextAt: firstAt + 24 * HOUR_MS });
  });
});
