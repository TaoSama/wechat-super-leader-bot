import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { AutomationService, MemoryAutomationRepository, createAutomationRouter } from "../src/automations/index.js";

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))); });
async function appFixture() {
  const now = Date.parse("2026-10-18T00:00:00Z");
  const repository = new MemoryAutomationRepository();
  const service = new AutomationService({ repository, now: () => now, runner: {
    start: async () => ({ status: "unknown", error: "not configured" }), inspect: async () => ({ status: "unknown", error: "not configured" }),
  } });
  const app = express(); app.use(express.json());
  app.use("/v1/automations", createAutomationRouter(service, {
    allowed: () => new Set(["allowed", "second-user"]), now: () => now,
    authority: async (req, chatId) => req.headers["x-test-user-action"] === "current"
      ? { chatId, currentMessageId: "current-user-message", explicitCurrentTurnAuthorization: true } : null,
  }));
  const server = app.listen(0, "127.0.0.1"); servers.push(server);
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No listening address");
  const origin = `http://127.0.0.1:${address.port}`;
  const create = (chatId = "allowed", consent = true) => fetch(`${origin}/v1/automations`, { method: "POST", headers: { "content-type": "application/json", ...(consent ? { "x-test-user-action": "current" } : {}) },
    body: JSON.stringify({ chatId, input: { kind: "reminder", title: "test reminder", text: "hello", timing: { type: "at", at: "2026-10-18T01:00:00Z" }, timezone: "Asia/Shanghai" } }),
  });
  return { origin, create };
}

describe("automation HTTP management", () => {
  it("creates, lists, pauses, resumes and cancels through real HTTP", async () => {
    const f = await appFixture();
    const created = await f.create(); expect(created.status).toBe(201);
    const { schedule } = await created.json();
    const listed = await fetch(`${f.origin}/v1/automations?chatId=allowed`);
    expect((await listed.json()).items[0].id).toBe(schedule.id);
    for (const status of ["paused", "active", "cancelled"]) {
      const response = await fetch(`${f.origin}/v1/automations/${schedule.id}/status`, { method: "POST", headers: { "content-type": "application/json", "x-test-user-action": "current" }, body: JSON.stringify({ chatId: "allowed", status }) });
      expect(response.status).toBe(200);
      expect((await response.json()).schedule.status).toBe(status);
    }
    const runs = await fetch(`${f.origin}/v1/automations/${schedule.id}/runs?chatId=allowed`);
    expect((await runs.json()).items).toEqual([]);
  });
  it("enforces allowlist and current authorization and hides other users' schedules", async () => {
    const f = await appFixture();
    expect((await f.create("blocked")).status).toBe(403);
    expect((await f.create("allowed", false)).status).toBe(403);
    const { schedule } = await (await f.create()).json();
    expect((await fetch(`${f.origin}/v1/automations/${schedule.id}?chatId=second-user`)).status).toBe(404);
    const response = await fetch(`${f.origin}/v1/automations?chatId=second-user`);
    expect((await response.json()).items).toEqual([]);
    expect((await fetch(`${f.origin}/v1/automations?chatId=blocked`)).status).toBe(403);
  });
});
