import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { test } from "node:test";
import { ResultClient } from "../../src/controller/result-client.js";
import { WeChatGateway } from "../../src/gateway.js";
import { FileResultOutbox } from "../../src/results/outbox.js";
import type { ResultDelivery } from "../../src/results/contracts.js";
import { StateManager } from "../../src/runtime/state.js";
import { ILinkClient } from "../../src/wechat/client.js";
import { harness, json } from "../fixtures/notification-fixtures.js";

const TEST_TIMEOUT_MS = 10_000;
const ATTEMPT_MS = 60_000;
const RETENTION_MS = 120_000;
const ORIGINAL_CONTEXT = "synthetic-context";
const FRESH_CONTEXT = "fresh-poll-context";
const ORDINARY_TEXT = "ordinary message ahead of notification";
const NOTICE_TEXT = "queued synthetic result notification";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

for (const newInbound of [false, true]) {
  test(`queued result notification ${newInbound ? "defers after a real inbound context change" : "sends when its context is unchanged"}`,
    { timeout: TEST_TIMEOUT_MS }, async t => {
      const f = harness(t), firstRequest = gate(), releaseFirst = gate(), checkedBeforeQueue = gate();
      const sends: Record<string, unknown>[] = [], requestErrors: unknown[] = [];
      const sendJson = (response: ServerResponse, value: unknown) => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(value));
      };
      const server = createServer((request, response) => {
        void (async () => {
          if (request.url === "/ilink/bot/getupdates") {
            sendJson(response, { ret: 0, get_updates_buf: "fresh-cursor", msgs: [{
              message_type: 1, from_user_id: "chat", client_id: "fresh-inbound", context_token: FRESH_CONTEXT,
              create_time_ms: Date.now(), item_list: [{ type: 1, text_item: { text: "fresh user input" } }],
            }] });
            return;
          }
          if (request.url === "/ilink/bot/getconfig" || request.url === "/ilink/bot/sendtyping") {
            sendJson(response, { ret: 0 }); return;
          }
          assert.equal(request.url, "/ilink/bot/sendmessage");
          const parts: Buffer[] = [];
          for await (const part of request) parts.push(Buffer.from(part));
          sends.push((JSON.parse(Buffer.concat(parts).toString("utf8")) as { msg: Record<string, unknown> }).msg);
          if (sends.length === 1) { firstRequest.resolve(); await releaseFirst.promise; }
          sendJson(response, { ret: 0, errcode: 0 });
        })().catch(error => { requestErrors.push(error); response.writeHead(500); response.end(); });
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      t.after(async () => {
        releaseFirst.resolve();
        await new Promise<void>((resolve, reject) => {
          server.close(error => error ? reject(error) : resolve());
          server.closeAllConnections();
        });
      });
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const ilink = new ILinkClient({ stateManager: f.state, configuredBaseUrl: "https://wechat.test",
        fetchImpl: (input, init) => {
          const url = new URL(String(input));
          assert.equal(url.origin, "https://wechat.test");
          return fetch(`http://127.0.0.1:${address.port}${url.pathname}`, init);
        } });
      const now = Date.now(), id = randomUUID(), artifactId = randomUUID();
      let item: ResultDelivery = { id, key: id, chatId: "chat", source: { type: "plan", id: "synthetic-plan" },
        kind: "completed", status: "ready", mode: "text", messages: [NOTICE_TEXT], createdAt: now - 1_000,
        expiresAt: now + RETENTION_MS, retainedUntil: now + RETENTION_MS,
        artifact: { id: artifactId, chatId: "chat", name: "result.md", size: 1, sha256: "a".repeat(64),
          expiresAt: now + RETENTION_MS } };
      const transitions: string[] = [];
      const client = new ResultClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: "synthetic",
        fetchImpl: async (input, init) => {
          const pathname = new URL(String(input)).pathname;
          const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          transitions.push(pathname);
          if (pathname === "/v1/chats/notification-interest") return json({ chatIds: ["chat"], interested: [] });
          if (pathname === "/v1/deliveries/pending") return json({ items: item.status === "ready" ? [item] : [] });
          if (pathname.endsWith("/claim")) {
            const attemptedAt = Date.now();
            item = { ...item, status: "claimed", attemptId: String(body.attemptId), attemptedAt, attemptExpiresAt: attemptedAt + ATTEMPT_MS };
          } else if (pathname.endsWith("/materialize")) {
            return json({ delivery: { ...item, artifact: { ...item.artifact,
              downloadUrl: `http://127.0.0.1:8790/v1/result-artifacts/${artifactId}/download?expires=${item.retainedUntil}&signature=${"b".repeat(64)}` } } });
          } else if (pathname.endsWith("/defer")) {
            const { attemptId, attemptedAt: _at, attemptExpiresAt: _expires, ...previous } = item;
            item = { ...previous, status: "waiting_for_user", lastDeferredAttemptId: attemptId,
              lastDeferReason: String(body.reason), lastDeferredAt: Date.now(), submittedMessages: Number(body.submittedMessages) };
          } else if (pathname.endsWith("/receipt")) {
            item = { ...item, status: body.status as "accepted" | "uncertain" };
          } else { throw new Error(`Unexpected synthetic Controller request: ${pathname}`); }
          return json({ delivery: item });
        } });
      const outbox = new FileResultOutbox(`${f.statePath}.results.json`, () => f.state.getLoginFingerprint());
      const gateway = new WeChatGateway({ stateManager: f.state, controller: f.controller, ilink,
        resultClient: client, resultOutbox: outbox, replyEngine: {
          requestBudgetMs: TEST_TIMEOUT_MS, reply: async () => ({ text: "" }), getReply: async () => ({ text: "" }),
          ackReply: async () => {},
        } });
      const checks: { context: string; allowed: boolean }[] = [];
      const sendMarkdown = ilink.sendMarkdownReply.bind(ilink);
      t.mock.method(ilink, "sendMarkdownReply", (...[chatId, text, options]: Parameters<ILinkClient["sendMarkdownReply"]>) => sendMarkdown(chatId, text, {
        ...options, shouldContinue: () => {
          const allowed = options?.shouldContinue?.() ?? true;
          checks.push({ context: f.state.contextTokens.chat, allowed });
          checkedBeforeQueue.resolve();
          return allowed;
        },
      }));
      const ordinary = ilink.sendSingleText("chat", ORDINARY_TEXT);
      await firstRequest.promise;
      const pending = gateway.deliverNotificationsOnce();
      try {
        await checkedBeforeQueue.promise;
        assert.deepEqual(checks, [{ context: ORIGINAL_CONTEXT, allowed: true }]);
        assert.equal(sends.length, 1);
        if (newInbound) {
          const poll = await gateway.pollOnce();
          assert.equal(poll.processedCount, 1);
          assert.equal(f.state.contextTokens.chat, FRESH_CONTEXT);
        }
      } finally { releaseFirst.resolve(); }
      await ordinary;
      assert.deepEqual(await pending, newInbound ? { accepted: 0, uncertain: 0, skipped: 1 } : { accepted: 1, uncertain: 0, skipped: 0 });
      assert.deepEqual(requestErrors, []);
      assert.equal(checks.length, 2, "admission must be checked again after the chat queue wait");
      assert.deepEqual(checks[1], { context: newInbound ? FRESH_CONTEXT : ORIGINAL_CONTEXT, allowed: !newInbound });
      assert.equal(sends.length, newInbound ? 1 : 2);
      assert.equal(item.status, newInbound ? "waiting_for_user" : "accepted");
      assert.equal(transitions.filter(path => path.endsWith("/receipt")).length, newInbound ? 0 : 1);
      assert.deepEqual(outbox.references(), []);
      const durable = new StateManager(f.accountPath, f.statePath), key = `result:${id}:step:0`;
      assert.equal(durable.replyDeliveries[key].inFlight, false);
      assert.equal(durable.replyDeliveries[key].acknowledgedChunks, newInbound ? 0 : 1);
      if (newInbound) {
        assert.equal(item.lastDeferReason, "context_changed");
        assert.equal(item.submittedMessages, 0);
        assert.equal(durable.accountSendBudget!.remaining, durable.policy.sendBudget, "stale notification spends no refreshed quota");
      } else {
        assert.equal(sends[1].context_token, ORIGINAL_CONTEXT);
        assert.deepEqual(sends[1].item_list, [{ type: 1, text_item: { text: NOTICE_TEXT } }]);
      }
    });
}
