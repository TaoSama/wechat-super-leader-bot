import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { AutomationService, CreateScheduleSchema, MemoryAutomationRepository, createAutomationRouter,
  type CreationAuthority } from "../src/automations/index.js";

const NOW = Date.parse("2026-11-03T00:00:00Z");
const CHAT = "prompt-owner";
const CURRENT_MESSAGE = "prompt-edit-1";
const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve()))));
});

async function fixture() {
  const repository = new MemoryAutomationRepository();
  const service = new AutomationService({ repository, now: () => NOW, validateBackground: async () => {},
    runner: { start: async () => ({ status: "running" }), inspect: async () => ({ status: "running" }) } });
  const schedule = await service.create(CreateScheduleSchema.parse({ kind: "background", title: "quantitative daily report",
    timing: { type: "cron", expression: "0 9 * * *" }, timezone: "Asia/Shanghai", background: { prompt: "original report" } }),
  { chatId: CHAT, currentMessageId: "creation-message", explicitCurrentTurnAuthorization: true });
  const consent: CreationAuthority = { chatId: CHAT, currentMessageId: CURRENT_MESSAGE,
    explicitCurrentTurnAuthorization: true, source: "admin_api" };
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/automations", createAutomationRouter(service, { allowed: () => new Set([CHAT, "other-owner"]), now: () => NOW,
    authority: async (req, chatId) => {
      switch (req.headers["x-test-authority"]) {
        case "current": return { ...consent, chatId, currentMessageId: String(req.headers["idempotency-key"] ?? CURRENT_MESSAGE) };
        case "wrong-chat": return { ...consent, chatId: "wrong-chat" };
        case "empty-message": return { ...consent, chatId, currentMessageId: "" };
        case "denied": return { ...consent, chatId, explicitCurrentTurnAuthorization: false };
        default: return null;
      }
    } }));
  const server = app.listen(0, "127.0.0.1"); servers.push(server);
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No prompt HTTP fixture address");
  const url = `http://127.0.0.1:${address.port}/automations/${schedule.id}/prompt`;
  const payload = { chatId: CHAT, prompt: "updated report", expectedPromptRevision: 0 };
  const post = (body: unknown = payload, key: string | undefined = "prompt-edit-1", authorization = "current", endpoint = url) => fetch(endpoint, {
    method: "POST", headers: { "content-type": "application/json", "x-test-authority": authorization,
      ...(key === undefined ? {} : { "idempotency-key": key }) }, body: JSON.stringify(body),
  });
  return { repository, service, schedule, consent, url, payload, post };
}

describe("background prompt HTTP edits", () => {
  it("persists a trimmed prompt through the real service and forwards trusted authority plus the stable key", async () => {
    const f = await fixture();
    const update = vi.spyOn(f.service, "updatePrompt");
    const response = await f.post({ ...f.payload, prompt: "  revised report format  " });
    expect(response.status).toBe(200);
    const { schedule } = await response.json();
    expect(schedule).toMatchObject({ id: f.schedule.id, status: f.schedule.status, nextAt: f.schedule.nextAt,
      authorizedMessageId: "creation-message", latestPromptUpdate: { revision: 1, source: "admin_api", requestId: CURRENT_MESSAGE },
      background: { prompt: "revised report format" } });
    expect(await f.repository.get(f.schedule.id, CHAT)).toMatchObject({ background: { prompt: "revised report format" } });
    expect(update).toHaveBeenCalledExactlyOnceWith(f.schedule.id,
      { prompt: "revised report format", expectedPromptRevision: 0 },
      { ...f.consent, idempotencyKey: "prompt-edit-1" }, NOW);
  });

  it("replays one stable edit and rejects stale revision without overwriting the persisted prompt", async () => {
    const f = await fixture();
    expect((await f.post()).status).toBe(200);
    const replay = await f.post();
    expect(replay.status).toBe(200);
    expect((await replay.json()).schedule.latestPromptUpdate.revision).toBe(1);
    expect((await f.post({ ...f.payload, prompt: "stale overwrite" }, "different-edit")).status).toBe(409);
    expect(await f.repository.get(f.schedule.id, CHAT)).toMatchObject({ latestPromptUpdate: { revision: 1 }, background: { prompt: "updated report" } });
  });

  it("accepts the exact prompt and idempotency-key size limits", async () => {
    const f = await fixture();
    const prompt = "x".repeat(128_000), key = "x".repeat(256);
    const response = await f.post({ ...f.payload, prompt }, key);
    expect(response.status).toBe(200);
    const { schedule } = await response.json();
    expect(schedule.background.prompt).toBe(prompt);
    expect(schedule.latestPromptUpdate).toMatchObject({ source: "admin_api", requestId: key, revision: 1 });
  });

  it("rejects empty, oversized, malformed and mixed-operation bodies before calling the service", async () => {
    const f = await fixture();
    const update = vi.spyOn(f.service, "updatePrompt");
    for (const patch of [
      { prompt: "" }, { prompt: " \n " }, { prompt: "x".repeat(128_001) },
      { expectedPromptRevision: -1 }, { expectedPromptRevision: 0.5 }, { expectedPromptRevision: Number.MAX_SAFE_INTEGER + 1 },
      { expectedPromptRevision: "0" }, { expectedPromptRevision: null },
      { status: "paused" }, { source: "admin_api" }, { currentMessageId: "forged" }, { messageId: "forged" },
      { background: { prompt: "nested" } },
    ]) expect((await f.post({ ...f.payload, ...patch })).status).toBe(400);
    expect((await f.post({ chatId: CHAT, prompt: "missing revision" })).status).toBe(400);
    expect((await f.post({ prompt: "missing owner", expectedPromptRevision: 0 })).status).toBe(400);
    expect((await f.post(f.payload, "invalid-id", "current", f.url.replace(f.schedule.id, "not-a-uuid"))).status).toBe(400);
    const plainText = await fetch(f.url, { method: "POST", headers: { "content-type": "text/plain", "idempotency-key": "text-edit" },
      body: JSON.stringify(f.payload) });
    expect(plainText.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  it("requires a stable bounded edit key while leaving the old status endpoint key-optional", async () => {
    const f = await fixture();
    const update = vi.spyOn(f.service, "updatePrompt");
    for (const key of [undefined, "", "contains space", "x".repeat(257)]) {
      const response = await fetch(f.url, { method: "POST", headers: { "content-type": "application/json", "x-test-authority": "current",
        ...(key === undefined ? {} : { "idempotency-key": key }) }, body: JSON.stringify(f.payload) });
      expect(response.status).toBe(400);
    }
    expect(update).not.toHaveBeenCalled();
    const status = await fetch(f.url.replace(/prompt$/, "status"), { method: "POST", headers: {
      "content-type": "application/json", "x-test-authority": "current" }, body: JSON.stringify({ chatId: CHAT, status: "paused" }) });
    expect(status.status).toBe(200);
    expect((await status.json()).schedule.status).toBe("paused");
  });

  it("enforces allowlist, trusted current authority and schedule ownership without revealing another owner's record", async () => {
    const f = await fixture();
    const update = vi.spyOn(f.service, "updatePrompt");
    expect((await f.post({ ...f.payload, chatId: "blocked" })).status).toBe(403);
    for (const authorization of ["absent", "wrong-chat", "empty-message", "denied"]) {
      expect((await f.post(f.payload, "authorized-edit", authorization)).status).toBe(403);
    }
    expect(update).not.toHaveBeenCalled();
    expect((await f.post({ ...f.payload, chatId: "other-owner" })).status).toBe(404);
    expect((await f.post(f.payload, "missing-edit", "current", f.url.replace(f.schedule.id, randomUUID()))).status).toBe(404);
    expect(await f.repository.get(f.schedule.id, CHAT)).toMatchObject({ background: { prompt: "original report" } });
  });
});
