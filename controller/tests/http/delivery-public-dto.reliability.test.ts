import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import { WebSocket } from "ws";
import { consoleDelivery, CONSOLE_DELIVERY_PREVIEW_CHARS } from "../../src/console/deliveries.js";
import type { DeliveryPlan } from "../../src/deliveries/contracts.js";
import { ControllerServer } from "../../src/http/server.js";
import type { Config } from "../../src/runtime/config.js";
import type { TaskNotifications } from "../../src/runtime/task-notifications.js";
import { MemoryStore } from "../../src/store/memory.js";

const NOW = Date.parse("2026-10-23T00:00:00Z");
const CHAT = "allowed-delivery-chat";
const ADMIN_TOKEN = "delivery-preview-admin";
const NODE_TOKEN = "delivery-preview-node";
const CONSOLE_ORIGIN = "http://127.0.0.1:8790";
const DELIVERY_COUNT = 100;
const SSE_MAX_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;
const bearer = { Authorization: `Bearer ${ADMIN_TOKEN}` };
const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
let server: ControllerServer | undefined;
let socket: WebSocket | undefined;

afterEach(async () => {
  for (const reader of readers.splice(0)) await reader.cancel();
  if (socket && socket.readyState !== WebSocket.CLOSED) {
    const closed = once(socket, "close");
    socket.close();
    await closed;
  }
  socket = undefined;
  await server?.stop();
  server = undefined;
});

function plan(messages: string[]): DeliveryPlan {
  return {
    id: "00000000-0000-4000-8000-000000000001", key: "private-idempotency", chatId: CHAT,
    source: { type: "plan", id: "private-source" }, kind: "completed", status: "claimed", mode: "text", messages,
    business: { category: "private-business", supersedes: "private-supersession" },
    artifact: { id: "00000000-0000-4000-8000-000000000002", chatId: CHAT, name: "complete-result.md",
      size: 20_000, sha256: "a".repeat(64), expiresAt: NOW + 86_400_000 },
    createdAt: NOW, expiresAt: NOW + 60_000, retainedUntil: NOW + 86_400_000,
    preparation: { token: "private-lease", until: NOW + 10_000 }, attemptId: "private-attempt",
    attemptedAt: NOW, attemptExpiresAt: NOW + 30_000, error: "private-error",
    catchupId: "private-catchup", catchupSourceIds: ["private-source"], resumeGeneration: "private-generation",
  };
}

it("exposes a list preview without delivery authority, private identifiers or artifact authorization", () => {
  const stored = plan(["果".repeat(3800), "complete later message"]);
  const original = structuredClone(stored);
  const projected = consoleDelivery(stored);
  expect(Object.keys(projected).sort()).toEqual([
    "artifact", "createdAt", "expiresAt", "id", "kind", "messages", "mode", "retainedUntil", "status",
  ]);
  expect(Object.keys(projected.artifact).sort()).toEqual(["expiresAt", "id", "name", "size"]);
  expect(projected).toMatchObject({ id: stored.id, kind: stored.kind, status: stored.status, mode: stored.mode,
    createdAt: stored.createdAt, expiresAt: stored.expiresAt, retainedUntil: stored.retainedUntil,
    artifact: { id: stored.artifact.id, name: stored.artifact.name, size: stored.artifact.size, expiresAt: stored.artifact.expiresAt } });
  expect(projected.messages).toEqual(["果".repeat(CONSOLE_DELIVERY_PREVIEW_CHARS)]);
  expect(JSON.stringify(projected)).not.toContain("private-");
  projected.artifact.name = "changed preview";
  projected.messages[0] = "changed preview";
  expect(stored).toEqual(original);
});

it.each([{ messages: [] }, { messages: ["short result"] }, { messages: ["果".repeat(240)] }])("preserves empty and fully visible notification previews: %j", ({ messages }) => {
  expect(consoleDelivery(plan(messages)).messages).toEqual(messages);
});

async function openStream(base: string, headers: Record<string, string>) {
  const response = await fetch(base + "/v1/events", { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader(); readers.push(reader);
  const decoder = new TextDecoder(); let buffered = "";
  return async () => {
    for (;;) {
      const delimiter = buffered.indexOf("\n\n");
      if (delimiter >= 0) {
        const frame = buffered.slice(0, delimiter); buffered = buffered.slice(delimiter + 2);
        if (!frame.startsWith("event: status\n")) continue;
        expect(Buffer.byteLength(frame)).toBeLessThan(SSE_MAX_BYTES);
        return JSON.parse(frame.slice("event: status\ndata: ".length));
      }
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Status stream closed before its delivery snapshot");
      buffered += decoder.decode(chunk.value, { stream: true });
    }
  };
}

it("serves bounded HTTP/Cookie/Bearer SSE for 100 full results while content and Gateway delivery remain complete", async () => {
  const config: Config = {
    port: 0, host: "127.0.0.1", controllerToken: ADMIN_TOKEN,
    nodeTokens: { fixture: NODE_TOKEN }, tokenToNode: new Map([[NODE_TOKEN, "fixture"]]),
    allowedChatIds: new Set([CHAT]), persistenceMode: "memory", commandTtlSeconds: 60,
    consolePublicUrl: CONSOLE_ORIGIN,
  };
  server = new ControllerServer(config, new MemoryStore(), undefined, () => NOW);
  await server.start();
  const base = `http://127.0.0.1:${(server.getHttpServer().address() as AddressInfo).port}`;
  const runtime = (server as unknown as { taskNotifications: TaskNotifications }).taskNotifications;
  const text = "# 完整 Markdown\n\n" + "果".repeat(11_000) + "\n最终证据😀";
  const prepare = (index: number, chatId = CHAT) => runtime.results.prepareResult({
    key: `private-key-${index}`, chatId, source: { type: "private-source-type", id: `fixture-source-${index}` },
    kind: "completed", text, createdAt: NOW - index, expiresAt: NOW + 60_000,
  });
  const first = await prepare(0);
  for (let index = 1; index < DELIVERY_COUNT; index++) await prepare(index);
  const denied = await prepare(DELIVERY_COUNT, "unauthorized-chat");
  expect(first.messages).toHaveLength(3);
  expect(Buffer.byteLength(JSON.stringify(await runtime.results.repository.list([CHAT])))).toBeGreaterThan(SSE_MAX_BYTES);

  const issued = await fetch(base + "/v1/console-links", { method: "POST", headers: { ...bearer, "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: "large-delivery-console" }) });
  const { url } = await issued.json();
  const exchange = await fetch(base + "/auth/exchange", { method: "POST", headers: { Origin: CONSOLE_ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({ token: new URLSearchParams(new URL(url).hash.slice(1)).get("login") }) });
  expect(exchange.status).toBe(200);
  const cookie = exchange.headers.get("set-cookie")!.split(";")[0]; await exchange.arrayBuffer();
  const consoleHeaders = { Cookie: cookie, Origin: CONSOLE_ORIGIN };
  const status = await fetch(base + "/v1/status", { headers: consoleHeaders });
  expect(status.status).toBe(200);
  const raw = await status.text(); expect(Buffer.byteLength(raw)).toBeLessThan(SSE_MAX_BYTES);
  const snapshot = JSON.parse(raw);
  expect(snapshot.deliveries).toHaveLength(DELIVERY_COUNT);
  expect(raw).not.toContain("private-");
  expect(raw).not.toContain(denied.id);
  expect(snapshot.deliveries[0].messages).toEqual([first.messages[0].slice(0, CONSOLE_DELIVERY_PREVIEW_CHARS)]);
  const streams = [await openStream(base, consoleHeaders), await openStream(base, bearer)];
  for (const next of streams) expect((await next()).deliveries).toEqual(snapshot.deliveries);

  const full = await fetch(`${base}/v1/deliveries/${first.id}/full`, { headers: consoleHeaders });
  expect(full.status).toBe(200); expect(await full.text()).toBe(text);
  const pending = await fetch(base + "/v1/deliveries/pending", { method: "POST", headers: { ...bearer, "Content-Type": "application/json" },
    body: JSON.stringify({ chatIds: [CHAT] }) });
  expect(pending.status).toBe(200);
  const selected = (await pending.json()).items[0] as DeliveryPlan;
  expect(selected).toBeDefined();
  expect(selected.messages).toEqual(first.messages);
  const attemptId = "00000000-0000-4000-8000-000000000003";
  const post = (suffix: string) => fetch(`${base}/v1/deliveries/${selected.id}/${suffix}`, { method: "POST",
    headers: { ...bearer, "Content-Type": "application/json" }, body: JSON.stringify({ attemptId }) });
  expect((await post("claim")).status).toBe(200);
  const materialized = await post("materialize"); expect(materialized.status).toBe(200);
  const actualDelivery = (await materialized.json()).delivery;
  expect(actualDelivery.messages).toEqual(first.messages);
  expect(actualDelivery.messages.join("")).toContain("最终证据😀");
  expect((await runtime.results.repository.get(selected.id, NOW))?.messages).toEqual(first.messages);

  // A real node update proves both existing streams continue after the large initial state.
  socket = new WebSocket(base.replace("http:", "ws:") + "/v1/daemon", { headers: { Authorization: `Bearer ${NODE_TOKEN}` } });
  await once(socket, "open");
  socket.send(JSON.stringify({ type: "hello", version: 1, nodeId: "fixture", sessions: [], skills: [] }));
  for (const next of streams) expect((await next()).deliveries.find((item: DeliveryPlan) => item.id === selected.id).status).toBe("claimed");
});
