import type { AddressInfo } from "node:net";
import { beforeEach, afterEach, it, expect } from "vitest";
import { ControllerServer } from "../src/server.js";
import { MemoryStore } from "../src/store/memory.js";
import type { Config } from "../src/config.js";
import { createExecution } from "../src/leader/execution.js";
import { NOTIFICATION_TTL_MS, NOTIFICATION_ATTEMPT_MS } from "../src/notifications.js";

const NOW = 1_700_000_000_000;
const ADMIN = "notification-admin";
const NODE = "notification-node-token";
const ORIGIN = "http://127.0.0.1:8790";
const uuid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
let server: ControllerServer, store: MemoryStore, config: Config, now: number, base: string, cookie: string;
const bearer = { Authorization: `Bearer ${ADMIN}` };

async function call(path: string, body?: unknown, headers: Record<string, string> = bearer) {
  const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: {
    "Content-Type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json(), headers: response.headers };
}
async function seed(index = 1, chatId = "allowed", createdAt = NOW) {
  const execution = createExecution(chatId, { id: uuid(index), expiresAt: NOW + 600_000,
    actions: [{ nodeId: "fixture", sessionId: "session", prompt: "private prompt", dependsOn: [], sendRoute: "control-socket" }] }, NOW);
  await store.createExecutionIfAbsent(execution);
  await store.compareAndSetExecution({ ...execution, revision: 2, status: "completed" }, 1, createdAt);
  return uuid(index);
}

beforeEach(async () => {
  now = NOW;
  store = new MemoryStore();
  config = { port: 0, host: "127.0.0.1", controllerToken: ADMIN, nodeTokens: { fixture: NODE },
    tokenToNode: new Map([[NODE, "fixture"]]), allowedChatIds: new Set(["allowed", "other"]), persistenceMode: "memory",
    commandTtlSeconds: 60, consolePublicUrl: ORIGIN };
  server = new ControllerServer(config, store, undefined, () => now);
  await server.start();
  base = `http://127.0.0.1:${(server.getHttpServer().address() as AddressInfo).port}`;
  const issued = await call("/v1/console-links", { requestId: "notifications-login" });
  const token = new URL(issued.body.url).hash.slice("#login=".length);
  const exchange = await fetch(base + "/auth/exchange", { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN }, body: JSON.stringify({ token }) });
  expect(exchange.status).toBe(200);
  cookie = exchange.headers.get("set-cookie")!.split(";")[0];
  await exchange.arrayBuffer();
});
afterEach(async () => { await server.stop(); });

it("only management Bearer can list, read, claim and receipt; Cookie/node credentials cannot", async () => {
  const id = await seed();
  const endpoints: [string, unknown?][] = [["/v1/notifications/pending", { chatIds: ["allowed"] }],
    [`/v1/notifications/${id}`], [`/v1/notifications/${id}/claim`, { attemptId: uuid(100) }],
    [`/v1/notifications/${id}/receipt`, { attemptId: uuid(100), status: "accepted" }]];
  for (const [path, body] of endpoints) {
    expect((await call(path, body, {})).status).toBe(401);
    expect((await call(path, body, { Cookie: cookie })).status).toBe(401);
    expect((await call(path, body, { Authorization: `Bearer ${NODE}` })).status).toBe(403);
  }
  const response = await call(`/v1/notifications/${id}`);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.body.notification).toMatchObject({ id, executionId: id, chatId: "allowed", status: "pending" });
  expect(response.body.notification.text).not.toContain("private prompt");
});

it("intersects requested chats with the current allowlist before LIMIT and lists without consuming attempts", async () => {
  for (let index = 1; index <= 5; index++) await seed(index, "other");
  await seed(6, "forbidden");
  const allowed = await seed(7, "allowed", NOW + 1);
  now++;
  const requested = await call("/v1/notifications/pending", { chatIds: ["allowed", "forbidden"] });
  expect(requested.status).toBe(200);
  expect(requested.body.items.map((item: { id: string }) => item.id)).toEqual([allowed]);
  expect((await store.getNotification(allowed, now))!.status).toBe("pending");
  expect((await call("/v1/notifications/pending", { chatIds: [] })).body.items).toEqual([]);
  const four = await call("/v1/notifications/pending", { chatIds: ["other"] });
  expect(four.body.items.map((item: { id: string }) => item.id)).toEqual([1, 2, 3, 4].map(uuid));
  config.allowedChatIds.delete("allowed");
  expect((await call("/v1/notifications/pending", { chatIds: ["allowed"] })).body.items).toEqual([]);
  expect((await call(`/v1/notifications/${allowed}/claim`, { attemptId: uuid(100) })).status).toBe(409);
});

it("strict JSON schemas reject query, extra fields, invalid IDs and oversized or invalid chat lists", async () => {
  const id = await seed();
  for (const body of [{}, { chatIds: ["allowed"], limit: 100 }, { chatIds: Array(129).fill("allowed") }, { chatIds: [" allowed"] }, { chatIds: [""] }])
    expect((await call("/v1/notifications/pending", body)).status).toBe(400);
  expect((await call("/v1/notifications/pending?limit=4", { chatIds: [] })).status).toBe(400);
  expect((await call(`/v1/notifications/${id}?token=x`)).status).toBe(400);
  expect((await call("/v1/notifications/not-a-uuid")).status).toBe(400);
  for (const body of [{ attemptId: "bad" }, { attemptId: uuid(100), chatId: "allowed" }, { attemptId: uuid(100), status: "claimed" }])
    expect((await call(`/v1/notifications/${id}/claim`, body)).status).toBe(400);
  expect((await call(`/v1/notifications/${id}/receipt`, { attemptId: uuid(100), status: "pending" })).status).toBe(400);
  expect((await call(`/v1/notifications/${id}/receipt`, { attemptId: uuid(100), status: "accepted", output: "secret" })).status).toBe(400);
  const wrongType = await fetch(`${base}/v1/notifications/${id}/claim`, { method: "POST", headers: { ...bearer, "Content-Type": "text/plain" }, body: JSON.stringify({ attemptId: uuid(100) }) });
  expect(wrongType.status).toBe(400);
  await wrongType.arrayBuffer();
  expect((await store.getNotification(id, now))!.status).toBe("pending");
});

it("single-winner claims never regrant sending; same-attempt late receipt after revocation can recover uncertainty", async () => {
  const id = await seed();
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => call(`/v1/notifications/${id}/claim`, { attemptId: uuid(100 + index) })));
  expect(results.filter(result => result.status === 200)).toHaveLength(1);
  expect(results.filter(result => result.status === 409)).toHaveLength(7);
  const claimed = results.find(result => result.status === 200)!.body.notification;
  expect(claimed).toMatchObject({ status: "claimed", attemptedAt: NOW, attemptExpiresAt: NOW + NOTIFICATION_ATTEMPT_MS });
  expect((await call(`/v1/notifications/${id}/claim`, { attemptId: claimed.attemptId })).status).toBe(409);
  now += NOTIFICATION_TTL_MS + 1;
  expect((await call(`/v1/notifications/${id}`)).body.notification.status).toBe("uncertain");
  expect((await call(`/v1/notifications/${id}/claim`, { attemptId: claimed.attemptId })).status).toBe(409);
  config.allowedChatIds.clear();
  expect((await call(`/v1/notifications/${id}/receipt`, { attemptId: uuid(999), status: "accepted" })).status).toBe(409);
  const uncertain = await call(`/v1/notifications/${id}/receipt`, { attemptId: claimed.attemptId, status: "uncertain" });
  expect(uncertain.body.notification.status).toBe("uncertain");
  const accepted = await call(`/v1/notifications/${id}/receipt`, { attemptId: claimed.attemptId, status: "accepted" });
  expect(accepted.body.notification.status).toBe("accepted");
  expect((await call(`/v1/notifications/${id}/receipt`, { attemptId: claimed.attemptId, status: "uncertain" })).body).toEqual(accepted.body);
});

it("expired unclaimed notifications are not delivered; unknown UUIDs return 404", async () => {
  const id = await seed();
  now += NOTIFICATION_TTL_MS;
  expect((await call("/v1/notifications/pending", { chatIds: ["allowed"] })).body.items).toEqual([]);
  expect((await call(`/v1/notifications/${id}`)).body.notification.status).toBe("expired");
  expect((await call(`/v1/notifications/${id}/claim`, { attemptId: uuid(100) })).status).toBe(409);
  const missing = uuid(999);
  expect((await call(`/v1/notifications/${missing}`)).status).toBe(404);
  expect((await call(`/v1/notifications/${missing}/claim`, { attemptId: uuid(100) })).status).toBe(404);
  expect((await call(`/v1/notifications/${missing}/receipt`, { attemptId: uuid(100), status: "accepted" })).status).toBe(404);
});
