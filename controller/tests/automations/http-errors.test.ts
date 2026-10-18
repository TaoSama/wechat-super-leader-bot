import { afterEach, describe, expect, it, vi } from "vitest";
import express, { type ErrorRequestHandler } from "express";
import type { Server } from "node:http";
import { AutomationService, MemoryAutomationRepository, createAutomationRouter } from "../../src/automations/index.js";

const NOW = Date.parse("2026-10-18T00:00:00Z");
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
});
const input = {
  kind: "reminder", title: "reminder", text: "hello", timezone: "Asia/Shanghai",
  timing: { type: "at", at: "2026-10-18T01:00:00Z" },
};
async function fixture() {
  const repository = new MemoryAutomationRepository();
  const service = new AutomationService({ repository, now: () => NOW, runner: {
    start: async () => ({ status: "unknown", error: "unused" }), inspect: async () => ({ status: "unknown", error: "unused" }),
  } });
  const observedErrors: unknown[] = [];
  const app = express();
  app.use(express.json());
  app.use("/automations", createAutomationRouter(service, {
    allowed: () => new Set(["user"]), now: () => NOW,
    authority: async (req, chatId) => req.headers["x-consent"] === "yes"
      ? { chatId, currentMessageId: "trusted-action", explicitCurrentTurnAuthorization: true } : null,
  }));
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    observedErrors.push(error);
    res.status(503).json({ error: "temporarily unavailable" });
  };
  app.use(errors);
  const server = app.listen(0, "127.0.0.1"); servers.push(server);
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No HTTP fixture address");
  const origin = `http://127.0.0.1:${address.port}/automations`;
  const post = (path: string, body: unknown, key?: string, consent = true) => fetch(origin + path, {
    method: "POST", headers: { "content-type": "application/json", ...(consent ? { "x-consent": "yes" } : {}),
      ...(key === undefined ? {} : { "idempotency-key": key }) }, body: JSON.stringify(body),
  });
  return { repository, observedErrors, post, create: (value: unknown = input, key?: string) => post("", { chatId: "user", input: value }, key) };
}

describe("automation HTTP error classification and creation identity", () => {
  it.each([
    { ...input, timezone: "Mars/Olympus" },
    { ...input, timing: { type: "at", at: "2026-10-17T23:59:59Z" } },
    { ...input, timing: { type: "cron", expression: "* * * * * *" } },
    { ...input, timing: { type: "cron", expression: "61 * * * *" } },
    { ...input, timing: { type: "cron", expression: "0 0 31 2 *" } },
  ])("returns 400 for invalid timing: %j", async value => {
    const f = await fixture();
    expect((await f.create(value, "invalid-timing")).status).toBe(400);
    expect(f.observedErrors).toEqual([]);
    expect(await f.repository.list("user")).toEqual([]);
  });

  it("requires a bounded stable creation key and does not create without one", async () => {
    const f = await fixture();
    for (const key of [undefined, "", "bad key", "a".repeat(257)]) expect((await f.create(input, key)).status).toBe(400);
    expect(await f.repository.list("user")).toEqual([]);
    expect((await f.create(input, "a".repeat(256))).status).toBe(201);
  });

  it("retries one key concurrently, rejects changed payload, and allows a separate key", async () => {
    const f = await fixture();
    const responses = await Promise.all([f.create(input, "create-1"), f.create(input, "create-1")]);
    expect(responses.map(response => response.status)).toEqual([201, 201]);
    const records = await Promise.all(responses.map(response => response.json()));
    expect(records[0].schedule.id).toBe(records[1].schedule.id);
    expect((await f.create({ ...input, text: "changed" }, "create-1")).status).toBe(409);
    expect(await f.repository.list("user")).toHaveLength(1);
    expect((await f.create({ ...input, text: "changed" }, "create-2")).status).toBe(201);
    expect(await f.repository.list("user")).toHaveLength(2);
  });

  it("keeps status changes key-optional, returns 409 for terminal schedules and preserves authorization", async () => {
    const f = await fixture();
    expect((await f.post("", { chatId: "user", input }, "key", false)).status).toBe(403);
    expect((await f.post("", { chatId: "blocked", input }, "key")).status).toBe(403);
    const { schedule } = await (await f.create(input, "key")).json();
    expect((await f.post(`/${schedule.id}/status`, { chatId: "user", status: "cancelled" })).status).toBe(200);
    expect((await f.post(`/${schedule.id}/status`, { chatId: "user", status: "active" })).status).toBe(409);
    expect(f.observedErrors).toEqual([]);
  });

  it("passes database and unexpected errors unchanged to the global 503 handler", async () => {
    const f = await fixture();
    const databaseError = new Error("connection reset");
    const get = vi.spyOn(f.repository, "get").mockRejectedValueOnce(databaseError);
    expect((await f.create(input, "database-outage")).status).toBe(503);
    expect(f.observedErrors).toEqual([databaseError]);
    get.mockRestore();
    const { schedule } = await (await f.create(input, "key")).json();
    const unexpectedError = new Error("Finished schedules cannot be resumed or modified");
    vi.spyOn(f.repository, "setStatus").mockRejectedValueOnce(unexpectedError);
    expect((await f.post(`/${schedule.id}/status`, { chatId: "user", status: "paused" })).status).toBe(503);
    expect(f.observedErrors).toEqual([databaseError, unexpectedError]);
  });
});
