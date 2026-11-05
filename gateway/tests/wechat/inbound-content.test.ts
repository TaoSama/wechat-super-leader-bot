import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ILinkClient } from "../../src/wechat/client.js";
import { StateManager } from "../../src/runtime/state.js";
import { parseInboundContent, QUOTE_MAX_CHARS } from "../../src/wechat/inbound-content.js";

const text = (value: string, extra: Record<string, unknown> = {}) => ({ type: 1, text_item: { text: value }, ...extra });
const voice = (transcript?: string) => ({ type: 3, voice_item: { playtime: 1200, ...(transcript === undefined ? {} : { text: transcript }) } });
const image = { type: 2, image_item: { mid_size: 16 } };

test("voice speech-to-text becomes the message text", () => {
  assert.deepEqual(parseInboundContent([voice("帮我看下今天的部署")]), { text: "帮我看下今天的部署", ownText: "帮我看下今天的部署" });
});

test("quoted text or voice is prefixed, delimited and truncated to the named limit", () => {
  const quoted = parseInboundContent([text("这个结论对吗？", { ref_msg: { title: "摘要", message_item: text("昨天\n上线了 3 个服务") } })]);
  assert.deepEqual(quoted, { text: "引用：「昨天 上线了 3 个服务」\n这个结论对吗？", ownText: "这个结论对吗？" });
  const fromVoice = parseInboundContent([text("继续", { ref_msg: { message_item: voice("先查日志") } })]);
  assert.equal(fromVoice?.text, "引用：「先查日志」\n继续");
  const fromTitle = parseInboundContent([text("看看这个", { ref_msg: { title: "季度报告.pdf", message_item: { type: 4 } } })]);
  assert.equal(fromTitle?.text, "引用：「季度报告.pdf」\n看看这个");
  const long = parseInboundContent([text("总结", { ref_msg: { message_item: text(`${"字".repeat(QUOTE_MAX_CHARS - 1)}🦊尾巴`) } })]);
  assert.equal(long?.text, `引用：「${"字".repeat(QUOTE_MAX_CHARS - 1)}…」\n总结`, "truncation never splits a surrogate pair");
  assert.equal(parseInboundContent([text("没有可引用内容", { ref_msg: { message_item: image } })])?.text, "没有可引用内容");
});

test("messages without usable text keep typed unsupported kinds", () => {
  assert.deepEqual(parseInboundContent([image]), { text: "", ownText: "", unsupportedKinds: ["image"] });
  assert.deepEqual(parseInboundContent([voice(), { type: 4 }, { type: 5 }, { type: 99 }, image]),
    { text: "", ownText: "", unsupportedKinds: ["voice", "file", "video", "unknown", "image"] });
  assert.equal(parseInboundContent([]), undefined);
  assert.equal(parseInboundContent([text(""), "not-an-item", null]), undefined);
});

test("mixed text and media forwards the text only", () => {
  assert.deepEqual(parseInboundContent([image, text("图里是什么问题？")]), { text: "图里是什么问题？", ownText: "图里是什么问题？" });
});

function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-inbound-content-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const accountPath = path.join(directory, "account.json");
  fs.writeFileSync(accountPath, JSON.stringify({ token: "synthetic-token", accountId: "content-fixture" }));
  return new StateManager(accountPath, path.join(directory, "state.json"));
}

test("pollBatch keeps voice, quoted and image-only messages with stable identities", async t => {
  const state = fixture(t);
  const message = (id: string | undefined, items: unknown[]) => ({ message_type: 1, from_user_id: "chat-a",
    create_time_ms: 1_800_000_000_000, ...(id ? { client_id: id } : {}), item_list: items });
  const msgs = [message("v", [voice("语音转文字")]), message("q", [text("回复", { ref_msg: { message_item: text("原文") } })]),
    message("i", [image]), message(undefined, [image]), message(undefined, [text("legacy")]), message("e", [])];
  const poll = () => new ILinkClient({ stateManager: state, configuredBaseUrl: "https://ilink.invalid",
    fetchImpl: async () => Response.json({ ret: 0, get_updates_buf: "next", msgs }) }).pollBatch();
  const batch = await poll();
  assert.equal(batch.rawMessageCount, 6);
  assert.deepEqual(batch.messages.map(item => [item.messageId.startsWith("det:") ? "det" : item.messageId, item.text, item.unsupportedKinds]), [
    ["v", "语音转文字", undefined], ["q", "引用：「原文」\n回复", undefined], ["i", "", ["image"]],
    ["det", "", ["image"]], ["det", "legacy", undefined],
  ]);
  const legacyDigest = crypto.createHash("sha256")
    .update(`content-fixture:chat-a:1800000000000:${state.syncBuf}:4:legacy`, "utf8").digest("hex").slice(0, 24);
  assert.equal(batch.messages[4].messageId, `det:${legacyDigest}`, "text-only identities are unchanged");
  assert.deepEqual((await poll()).messages.map(item => item.messageId), batch.messages.map(item => item.messageId));
});
