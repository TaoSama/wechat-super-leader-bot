import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateManager } from "../../src/runtime/state.js";
import { FileInboundInbox } from "../../src/runtime/inbox.js";
import { ControllerClient } from "../../src/controller/client.js";
import { ILinkClient } from "../../src/wechat/client.js";
import { WeChatGateway } from "../../src/gateway.js";
import { QueryProgress } from "../../src/leader/progress.js";

test("polling deduplicates repeated root and supplemental messages while steering a running query", { timeout: 30_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "gateway-steering-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const credentials = join(directory, "account.json"), statePath = join(directory, "state.json");
  writeFileSync(credentials, JSON.stringify({ token: "test", accountId: "test-account" }));
  const state = new StateManager(credentials, statePath);
  state.markBaselineEstablished();
  let ready!: () => void, complete!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const completion = new Promise<void>(resolve => { complete = resolve; });
  const texts: string[] = [], appended: string[] = [], budgets: number[] = [], failures: Error[] = [];
  let polls = 0, runs = 0;
  let progress: QueryProgress;
  const controller = new ControllerClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: "test",
    fetchImpl: async url => {
      if (String(url).endsWith("/v1/chats/authorize")) return Response.json({ allowed: true });
      if (String(url).endsWith("/v1/notifications/pending")) return Response.json({ items: [] });
      throw new Error(`Unexpected controller endpoint: ${new URL(String(url)).pathname}`);
    } });
  const message = (id: string, text: string) => ({ message_type: 1, from_user_id: "chat", client_id: id,
    context_token: `ctx-${id}`, create_time_ms: Date.now(), item_list: [{ type: 1, text_item: { text } }] });
  let gateway: WeChatGateway;
  const ilink = new ILinkClient({ stateManager: state, configuredBaseUrl: "https://wechat.example",
    fetchImpl: async (url, init) => {
      if (String(url).endsWith("getupdates")) {
        polls++;
        if (polls === 1) return Response.json({ ret: 0, get_updates_buf: "one",
          msgs: [message("one", "查一下部署情况")].flatMap(message => [message, message]) });
        if (polls === 2) {
          await started;
          return Response.json({ ret: 0, get_updates_buf: "two",
            msgs: [message("two", "只看今天"), message("three", "按服务分组")].flatMap(message => [message, message]) });
        }
        await new Promise(resolve => setTimeout(resolve, 1));
        return Response.json({ ret: 0, get_updates_buf: "done", msgs: [] });
      }
      if (String(url).endsWith("getconfig")) return Response.json({ ret: 0, typing_ticket: "ticket" });
      if (String(url).endsWith("sendtyping")) return Response.json({ ret: 0 });
      if (String(url).endsWith("sendmessage")) {
        const text = JSON.parse(String(init?.body)).msg.item_list[0].text_item.text;
        texts.push(text);
        if (text === "今天，按服务分组的最终结果") gateway.stop();
        return Response.json({ ret: 0 });
      }
      throw new Error("Unexpected WeChat endpoint");
    } });
  gateway = new WeChatGateway({ stateManager: state, ilink, controller, replyEngine: {
    requestBudgetMs: 1000,
    async reply(_account, request, _controller, options) {
      runs++;
      progress = new QueryProgress(request, options?.progress);
      budgets.push((await progress.report("已找到相关部署记录，正在核对时间。")).remaining);
      ready();
      await completion;
      return { text: "今天，按服务分组的最终结果" };
    },
    async steer(_account, request) {
      appended.push(request.text);
      budgets.push((await progress.report(`已结合补充要求：${request.text}`)).remaining);
      if (appended.length === 2) {
        assert.equal((await progress.report("这一条不应发送")).remaining, 0);
        complete();
      }
      return true;
    },
    async getReply() { throw new Error("Live query must not be read as a completed reply"); },
    async ackReply() {},
  } });
  t.after(() => { complete(); gateway.stop(); });
  await gateway.runLoop(1, error => { failures.push(error); complete(); gateway.stop(); });
  assert.deepEqual(failures, []);
  assert.equal(runs, 1);
  assert.ok(polls >= 2);
  assert.deepEqual(appended, ["只看今天", "按服务分组"]);
  assert.deepEqual(budgets, [2, 1, 0]);
  assert.equal(texts.length, 4);
  assert.equal(texts.at(-1), "今天，按服务分组的最终结果");
  assert.equal(state.processedMessageKeys.length, 3);
  assert.deepEqual(new FileInboundInbox(`${statePath}.inbox.json`, () => state.getLoginFingerprint(), 1000).list(), []);
});
