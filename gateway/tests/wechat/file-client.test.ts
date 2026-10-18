import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ILinkClient } from "../../src/wechat/client.js";
import { StateManager } from "../../src/runtime/state.js";
import type { UploadedFileItem } from "../../src/wechat/file-upload.js";

const BYTES = Buffer.from("# 完整任务成果\n\n这是下载并验证过的正文。\n");
const FILE = { fileName: "研究成果.md", byteLength: BYTES.length,
  sha256: createHash("sha256").update(BYTES).digest("hex") };

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "gateway-file-client-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const credentials = join(directory, "account.json"), statePath = join(directory, "state.json");
  writeFileSync(credentials, JSON.stringify({ token: "synthetic-private", accountId: "fixture" }));
  const state = new StateManager(credentials, statePath);
  state.recordInboundContext("inbound-key", "chat", Date.now() - 1000, true, "synthetic-context");
  const calls: string[] = [], sends: Record<string, unknown>[] = [];
  let sendHook: (() => Promise<Response> | Response) | undefined;
  let uploadHook: (() => Promise<Response> | Response) | undefined;
  let checkOriginalBudget = true;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); calls.push(url.pathname);
    if (url.pathname === "/c2c/upload") {
      assert.equal(url.hostname, "novac2c.cdn.weixin.qq.com");
      assert.equal((init?.headers as Record<string, string>).Authorization, undefined);
      assert.ok(init?.body instanceof Uint8Array);
      return uploadHook ? uploadHook() : new Response(null, { headers: { "x-encrypted-param": "synthetic-download" } });
    }
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer synthetic-private");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (url.pathname.endsWith("getconfig")) return Response.json({ ret: 0, typing_ticket: "synthetic-ticket" });
    if (url.pathname.endsWith("sendtyping")) return Response.json({ ret: 0 });
    if (url.pathname.endsWith("getuploadurl")) {
      assert.equal(body.media_type, 3);
      assert.equal(body.rawsize, BYTES.length);
      if (checkOriginalBudget) assert.equal(state.contextBudgets.chat.remaining, 10, "upload alone never consumes a send");
      return Response.json({ ret: 0, upload_param: "synthetic-upload" });
    }
    assert.ok(url.pathname.endsWith("sendmessage"));
    sends.push(body.msg as Record<string, unknown>);
    return sendHook ? sendHook() : Response.json({ ret: 0 });
  };
  const client = (manager = state, maxFileBytes?: number) => new ILinkClient({ stateManager: manager, fetchImpl, maxFileBytes });
  return { state, calls, sends, client, restart: () => new StateManager(credentials, statePath),
    setSendHook: (next: typeof sendHook) => { sendHook = next; },
    setUploadHook: (next: typeof uploadHook) => { uploadHook = next; },
    allowSpentBudget: () => { checkOriginalBudget = false; } };
}

test("client authorizes FILE upload and confirms its type=4 send against the shared durable ledger", async t => {
  const f = fixture(t);
  assert.equal(await f.client().sendFileReply("chat", BYTES, FILE, { deliveryKey: "file" }), 1);
  assert.deepEqual(f.calls, ["/ilink/bot/getuploadurl", "/c2c/upload", "/ilink/bot/sendmessage"]);
  assert.equal(f.state.contextBudgets.chat.remaining, 9);
  const sent = f.sends[0], item = (sent.item_list as UploadedFileItem[])[0];
  assert.equal(sent.context_token, "synthetic-context");
  assert.equal(item.type, 4);
  assert.equal(item.file_item.file_name, FILE.fileName);
  assert.equal(item.file_item.len, String(BYTES.length));
  assert.equal(item.file_item.media.encrypt_type, 1);
  assert.equal(f.restart().replyDeliveries.file.acknowledgedChunks, 1);
  await f.client(f.restart()).sendFileReply("chat", BYTES, FILE, { deliveryKey: "file" });
  assert.equal(f.sends.length, 1);
  assert.equal(f.calls.length, 3, "completed files do not upload again after restart");
});

test("file upload failure and local size or integrity rejection never consume chat quota", async t => {
  for (const phase of ["upload", "size", "integrity"]) {
    const f = fixture(t);
    if (phase === "upload") f.setUploadHook(() => new Response(null, { status: 400 }));
    const client = f.client(f.state, phase === "size" ? BYTES.length - 1 : undefined);
    await assert.rejects(client.sendFileReply("chat", BYTES,
      phase === "integrity" ? { ...FILE, sha256: "0".repeat(64) } : FILE, { deliveryKey: phase }));
    assert.equal(f.state.contextBudgets.chat.remaining, 10);
    assert.equal(f.sends.length, 0);
    assert.equal(f.state.replyDeliveries[phase].inFlight, false);
    if (phase !== "upload") assert.equal(f.calls.length, 0);
  }
});

test("file response loss persists unknown outcome before restart and forbids every replay", async t => {
  const f = fixture(t);
  f.setSendHook(() => { throw new Error("synthetic response loss"); });
  await assert.rejects(f.client().sendFileReply("chat", BYTES, FILE, { deliveryKey: "unknown" }), /response loss/);
  assert.equal(f.restart().replyDeliveries.unknown.inFlight, true);
  await assert.rejects(f.client(f.restart()).sendFileReply("chat", BYTES, FILE, { deliveryKey: "unknown" }), /delivery uncertain/);
  assert.equal(f.sends.length, 1);
  assert.equal(f.calls.filter(path => path === "/c2c/upload").length, 1);
  assert.equal(f.restart().contextBudgets.chat.remaining, 9);
});

test("explicit file rejection clears uncertainty and retry preserves deterministic client ID", async t => {
  const f = fixture(t);
  f.setSendHook(() => Response.json({ ret: -2 }));
  await assert.rejects(f.client().sendFileReply("chat", BYTES, FILE, { deliveryKey: "rejected" }), /RejectedRet/);
  assert.equal(f.state.replyDeliveries.rejected.inFlight, false);
  f.allowSpentBudget(); f.setSendHook(undefined);
  await f.client().sendFileReply("chat", BYTES, FILE, { deliveryKey: "rejected" });
  assert.equal(f.sends[0].client_id, f.sends[1].client_id);
  assert.equal(f.state.replyDeliveries.rejected.acknowledgedChunks, 1);
});

test("file and ordinary text sends use one chat lock and cannot overspend the final shared send", async t => {
  const f = fixture(t); f.allowSpentBudget();
  f.state.contextBudgets.chat.remaining = 1; f.state.saveState();
  const client = f.client();
  const outcomes = await Promise.allSettled([
    client.sendFileReply("chat", BYTES, FILE, { deliveryKey: "file" }),
    client.sendMarkdownReply("chat", "普通回复优先", { deliveryKey: "text" }),
  ]);
  assert.equal(outcomes.filter(item => item.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter(item => item.status === "rejected").length, 1);
  assert.equal(f.sends.length, 1);
  assert.equal(f.state.contextBudgets.chat.remaining, 0);
});

test("admission guard is checked before consuming the last non-reserved file send", async t => {
  const f = fixture(t); f.allowSpentBudget();
  f.state.contextBudgets.chat.remaining = 4; f.state.saveState();
  assert.equal(await f.client().sendFileReply("chat", BYTES, FILE, { deliveryKey: "guard",
    shouldContinue: () => f.state.contextBudgets.chat.remaining > 3,
  }), 1);
  assert.equal(f.state.contextBudgets.chat.remaining, 3);
  assert.equal(f.state.replyDeliveries.guard.inFlight, false);
});

test("file and text cannot overlap sendmessage requests for the same chat", async t => {
  const f = fixture(t); f.allowSpentBudget();
  let active = 0, maximum = 0;
  f.setSendHook(async () => {
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    return Response.json({ ret: 0 });
  });
  const client = f.client();
  await Promise.all([
    client.sendFileReply("chat", BYTES, FILE, { deliveryKey: "file" }),
    client.sendMarkdownReply("chat", "普通回复", { deliveryKey: "text" }),
  ]);
  assert.equal(maximum, 1);
  assert.equal(f.sends.length, 2);
  assert.equal(f.state.contextBudgets.chat.remaining, 8);
});

test("new context or renewed window during CDN upload cancels the old file before final submission", async t => {
  for (const mutation of ["context", "window", "account"]) {
    const f = fixture(t);
    f.setUploadHook(() => {
      if (mutation === "context") f.state.setContextToken("chat", "new-context");
      if (mutation === "window") f.state.recordInboundContext("new-inbound", "chat", Date.now() - 500);
      if (mutation === "account") f.state.account!.token = "replacement-token";
      return new Response(null, { headers: { "x-encrypted-param": "synthetic-download" } });
    });
    await assert.rejects(f.client().sendFileReply("chat", BYTES, FILE, { deliveryKey: mutation }), /reply interrupted/);
    assert.equal(f.sends.length, 0);
    assert.equal(f.state.contextBudgets.chat.remaining, 10);
    assert.equal(f.state.replyDeliveries[mutation].inFlight, false);
  }
});
