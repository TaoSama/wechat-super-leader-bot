import { describe, expect, it, vi } from "vitest";
import {
  AutomationService, CreateScheduleSchema, MemoryAutomationRepository,
  type AutomationRunner, type CreateSchedule, type CreationAuthority,
} from "../src/automations/index.js";
import { AutomationConflictError, AutomationValidationError } from "../src/automations/errors.js";
import { BackgroundService, MemoryBackgroundRepository } from "../src/background/index.js";

const NOW = Date.parse("2026-11-03T00:00:00Z");
const MINUTE_MS = 60_000;
const authority: CreationAuthority = {
  chatId: "chat", currentMessageId: "create-message", explicitCurrentTurnAuthorization: true,
};
const editAuthority: CreationAuthority = { ...authority, currentMessageId: "edit-message" };
function input(timing: CreateSchedule["timing"] = { type: "at", at: new Date(NOW).toISOString() }): CreateSchedule {
  return CreateScheduleSchema.parse({
    kind: "background", title: "跨机器检查", timing, timezone: "UTC",
    background: { prompt: "原提示词", preferences: ["只报重要变化"], deadlineMs: MINUTE_MS },
  });
}
function fixture() {
  const repository = new MemoryAutomationRepository();
  const runner: AutomationRunner = {
    start: vi.fn(async () => ({ status: "completed" as const, result: { text: "旧结果" } })),
    inspect: vi.fn(async () => ({ status: "running" as const })),
  };
  const service = new AutomationService({ repository, runner, validateBackground: async () => undefined, now: () => NOW });
  return { repository, runner, service };
}

describe("background prompt edits and durable revisions", () => {
  it("normalizes one edit without changing the schedule contract or creation authority", async () => {
    const f = fixture();
    const created = await f.service.create(input(), authority);
    const updated = await f.service.updatePrompt(created.id,
      { prompt: "  新提示词\n", expectedPromptRevision: 0 }, editAuthority, NOW + 1);
    expect(updated).toMatchObject({
      ...created, background: { ...(created.kind === "background" ? created.background : {}), prompt: "新提示词" },
      updatedAt: NOW + 1, creationFingerprint: expect.any(String),
      latestPromptUpdate: { revision: 1, source: "current_turn", requestId: "edit-message", updatedAt: NOW + 1 },
    });
    expect(updated?.authorizedMessageId).toBe("create-message");
    expect(created.latestPromptUpdate).toBeUndefined();
  });

  it("keeps equal normalized prompts read-only and does not consume the request key", async () => {
    const f = fixture();
    const created = await f.service.create(input(), authority);
    const admin: CreationAuthority = { ...editAuthority, source: "admin_api" };
    expect(await f.service.updatePrompt(created.id,
      { prompt: " 原提示词\n", expectedPromptRevision: 0 }, admin, NOW + 1)).toEqual(created);
    expect(await f.service.updatePrompt(created.id,
      { prompt: "真正修改", expectedPromptRevision: 0 }, admin, NOW + 2)).toMatchObject({
      latestPromptUpdate: { revision: 1, updatedAt: NOW + 2 },
    });
    const before = await f.repository.get(created.id, "chat");
    expect(await f.service.updatePrompt(created.id,
      { prompt: " 真正修改 ", expectedPromptRevision: 1 }, { ...admin, currentMessageId: "unused-key" }, NOW + 3)).toEqual(before);
    expect(await f.repository.get(created.id, "chat")).toEqual(before);
  });

  it("uses revisions rather than timestamps to reject two simultaneous edits", async () => {
    const f = fixture();
    const created = await f.service.create(input(), authority);
    const attempts = await Promise.allSettled(["first", "second"].map(prompt => f.service.updatePrompt(created.id,
      { prompt, expectedPromptRevision: 0 }, { ...editAuthority, currentMessageId: prompt }, NOW)));
    expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find(result => result.status === "rejected");
    expect(rejected && rejected.status === "rejected" && rejected.reason).toBeInstanceOf(AutomationConflictError);
    expect(await f.repository.get(created.id, "chat")).toMatchObject({ latestPromptUpdate: { revision: 1 }, updatedAt: NOW });
  });

  it("permits another current-turn edit with a fresh revision but rejects stale revisions", async () => {
    const f = fixture();
    const created = await f.service.create(input(), authority);
    await f.service.updatePrompt(created.id, { prompt: "first", expectedPromptRevision: 0 }, editAuthority, NOW + 1);
    await f.service.updatePrompt(created.id, { prompt: "second", expectedPromptRevision: 1 }, editAuthority, NOW + 1);
    await expect(f.service.updatePrompt(created.id, { prompt: "second", expectedPromptRevision: 0 }, editAuthority))
      .rejects.toBeInstanceOf(AutomationConflictError);
    await expect(f.service.updatePrompt(created.id, { prompt: "second", expectedPromptRevision: 1 },
      { ...editAuthority, currentMessageId: "different-turn" })).rejects.toBeInstanceOf(AutomationConflictError);
    expect(await f.repository.get(created.id, "chat")).toMatchObject({ latestPromptUpdate: { revision: 2 } });
  });

  it("accepts only the exact last admin receipt retry, including after a run starts and completes", async () => {
    const f = fixture();
    const created = await f.service.create(input(), authority);
    const admin: CreationAuthority = { ...editAuthority, source: "admin_api" };
    const edit = { prompt: "new", expectedPromptRevision: 0 };
    await f.service.updatePrompt(created.id, edit, admin, NOW + 1);
    const [claimed] = await f.repository.claimDue(NOW + 2, "owner", 1);
    const running = await f.repository.get(created.id, "chat");
    expect(await f.service.updatePrompt(created.id, { ...edit, prompt: " new " }, admin, NOW + 3)).toEqual(running);
    await expect(f.service.updatePrompt(created.id, { ...edit, prompt: "different" }, admin))
      .rejects.toBeInstanceOf(AutomationConflictError);
    await expect(f.service.updatePrompt(created.id, { ...edit, expectedPromptRevision: 1 }, admin))
      .rejects.toBeInstanceOf(AutomationConflictError);
    await expect(f.service.updatePrompt(created.id, edit, { ...editAuthority, currentMessageId: admin.currentMessageId }))
      .rejects.toBeInstanceOf(AutomationConflictError);
    await f.repository.finish(claimed.run.id, "owner", { status: "completed", result: { text: "done" } }, NOW + 4);
    const completed = await f.repository.get(created.id, "chat");
    expect(completed?.status).toBe("completed");
    expect(await f.service.updatePrompt(created.id, edit, admin, NOW + 5)).toEqual(completed);
    await expect(f.service.updatePrompt(created.id, { prompt: "another", expectedPromptRevision: 1 },
      { ...admin, currentMessageId: "new-admin-request" })).rejects.toBeInstanceOf(AutomationConflictError);
  });

  it("keeps creation retries idempotent after editing while rejecting changed or forged creation payloads", async () => {
    const f = fixture();
    const createAuthority = { ...authority, idempotencyKey: "create-key" };
    const original = input();
    const created = await f.service.create(original, createAuthority);
    const updated = await f.service.updatePrompt(created.id, { prompt: "edited", expectedPromptRevision: 0 }, editAuthority);
    expect(await f.service.create(original, createAuthority)).toEqual(updated);
    await expect(f.service.create({ ...original, title: "changed payload" }, createAuthority))
      .rejects.toBeInstanceOf(AutomationConflictError);
    if (!updated || updated.kind !== "background") throw new Error("Expected edited background schedule");
    await expect(f.repository.create({ ...updated, background: { ...updated.background, prompt: "forged" } }))
      .rejects.toBeInstanceOf(AutomationConflictError);
    expect(await f.service.updatePrompt(created.id, { prompt: "edited twice", expectedPromptRevision: 1 }, editAuthority))
      .toMatchObject({ creationFingerprint: updated.creationFingerprint });
    expect(await f.service.create(original, createAuthority)).toMatchObject({ latestPromptUpdate: { revision: 2 } });
    const modelCreated = await f.service.create(original, authority);
    await f.service.updatePrompt(modelCreated.id, { prompt: "model edit", expectedPromptRevision: 0 }, editAuthority);
    expect(await f.service.create(original, authority)).toMatchObject({ id: modelCreated.id, latestPromptUpdate: { revision: 1 } });
  });

  it("requires live authorization for edits and for read-only retries", async () => {
    const f = fixture();
    const created = await f.service.create(input(), authority);
    const edit = { prompt: "new", expectedPromptRevision: 0 };
    await expect(f.service.updatePrompt(created.id, edit, { ...editAuthority, explicitCurrentTurnAuthorization: false }))
      .rejects.toThrow("authorization");
    const revoked = vi.fn(async () => { throw new Error("authorization revoked"); });
    await expect(f.service.updatePrompt(created.id, edit, { ...editAuthority, assertCurrentAuthority: revoked }))
      .rejects.toThrow("revoked");
    expect(await f.repository.get(created.id, "chat")).toEqual(created);
    await f.service.updatePrompt(created.id, edit, editAuthority);
    await expect(f.service.updatePrompt(created.id, edit, { ...editAuthority, assertCurrentAuthority: revoked }))
      .rejects.toThrow("revoked");
    expect(revoked).toHaveBeenCalledTimes(2);
  });

  it("does not expose or modify a different chat's schedule", async () => {
    const f = fixture();
    const created = await f.service.create(input(), authority);
    expect(await f.service.updatePrompt(created.id, { prompt: "new", expectedPromptRevision: 0 },
      { ...editAuthority, chatId: "other-chat" })).toBeNull();
    expect(await f.repository.get(created.id, "chat")).toEqual(created);
  });

  it("rejects authority revoked while the repository authorization check is pending", async () => {
    const f = fixture();
    const created = await f.service.create(input(), authority);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let checks = 0;
    let allowed = true;
    const attempted = Promise.allSettled([f.service.updatePrompt(created.id,
      { prompt: "must not commit", expectedPromptRevision: 0 }, {
        ...editAuthority, assertCurrentAuthority: async () => {
          checks += 1;
          if (checks > 1) await gate;
          if (!allowed) throw new Error("authorization revoked during repository check");
        },
      })]);
    try {
      await vi.waitFor(() => expect(checks).toBeGreaterThanOrEqual(2));
      allowed = false;
    } finally { release(); }
    const [result] = await attempted;
    expect(result.status).toBe("rejected");
    expect(result.status === "rejected" && result.reason).toEqual(new Error("authorization revoked during repository check"));
    expect(await f.repository.get(created.id, "chat")).toEqual(created);
  });

  it("allows paused edits but refuses new edits while running or after cancellation", async () => {
    const f = fixture();
    const created = await f.service.create(input(), authority);
    await f.repository.setStatus(created.id, "chat", "paused", NOW + 1);
    expect(await f.service.updatePrompt(created.id, { prompt: "paused edit", expectedPromptRevision: 0 }, editAuthority))
      .toMatchObject({ status: "paused", latestPromptUpdate: { revision: 1 } });
    await f.repository.setStatus(created.id, "chat", "active", NOW + 2);
    await f.repository.claimDue(NOW + 3, "owner", 1);
    await expect(f.service.updatePrompt(created.id, { prompt: "running edit", expectedPromptRevision: 1 }, editAuthority))
      .rejects.toBeInstanceOf(AutomationConflictError);
    await f.repository.setStatus(created.id, "chat", "cancelled", NOW + 4);
    await expect(f.service.updatePrompt(created.id, { prompt: "cancelled edit", expectedPromptRevision: 1 }, editAuthority))
      .rejects.toBeInstanceOf(AutomationConflictError);
  });

  it("rejects other schedule kinds and invalid update input", async () => {
    const f = fixture();
    const background = input({ type: "at", at: new Date(NOW + MINUTE_MS).toISOString() });
    const { background: _background, ...base } = background as Extract<CreateSchedule, { kind: "background" }>;
    const created = await f.service.create(CreateScheduleSchema.parse({ ...base, kind: "reminder", text: "reminder" }), authority);
    await expect(f.service.updatePrompt(created.id, { prompt: "new", expectedPromptRevision: 0 }, editAuthority))
      .rejects.toBeInstanceOf(AutomationValidationError);
    const valid = await f.service.create(background, authority);
    for (const update of [{ prompt: " ", expectedPromptRevision: 0 }, { prompt: "new", expectedPromptRevision: -1 }]) {
      await expect(f.service.updatePrompt(valid.id, update, editAuthority)).rejects.toThrow();
    }
  });

  it("passes the edited prompt to future workers while preserving old workers, runs and results", async () => {
    const f = fixture();
    const backgroundRepository = new MemoryBackgroundRepository();
    const runtime = {
      start: vi.fn(async () => ({ status: "completed" as const, summary: "旧结果" })),
      inspect: vi.fn(async () => ({ status: "completed" as const, summary: "旧结果" })),
      exportArtifacts: async () => [], cancel: async () => undefined, cleanup: async () => undefined,
    };
    const background = new BackgroundService({ repository: backgroundRepository, runtime,
      sources: { inspectAutomation: async () => { throw new Error("No sources configured"); } },
      deliverSupplement: async () => undefined, now: () => NOW });
    const created = await f.service.create(input({ type: "cron", expression: "* * * * *" }), authority);
    const [first] = await f.repository.claimDue(created.nextAt!, "owner", 1);
    if (first.schedule.kind !== "background") throw new Error("Expected background schedule");
    const outcome = await background.start(first.run, first.schedule.background);
    await f.repository.finish(first.run.id, "owner", outcome, first.run.scheduledAt + 1);
    const oldWorker = await backgroundRepository.getByRun(first.run.id);
    const oldRuns = await f.repository.listRuns(created.id, "chat");
    const oldOutbox = await f.repository.pendingOutbox(first.run.scheduledAt + 1);
    await f.service.updatePrompt(created.id, { prompt: "未来提示词", expectedPromptRevision: 0 }, editAuthority, first.run.scheduledAt + 2);
    expect(await backgroundRepository.getByRun(first.run.id)).toEqual(oldWorker);
    expect(await f.repository.listRuns(created.id, "chat")).toEqual(oldRuns);
    expect(await f.repository.pendingOutbox(first.run.scheduledAt + 2)).toEqual(oldOutbox);
    const current = await f.repository.get(created.id, "chat");
    const [second] = await f.repository.claimDue(current!.nextAt!, "owner", 1);
    if (second.schedule.kind !== "background") throw new Error("Expected background schedule");
    await background.start(second.run, second.schedule.background);
    expect((await backgroundRepository.getByRun(second.run.id))?.spec.prompt).toBe("未来提示词");
    expect((await backgroundRepository.getByRun(first.run.id))?.spec.prompt).toBe("原提示词");
    expect(runtime.start).toHaveBeenCalledTimes(2);
  });
});
