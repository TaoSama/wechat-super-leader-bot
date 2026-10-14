import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

import { StateManager } from "../../gateway/dist/runtime/state.js";
import { ILinkClient, DEFAULT_ILINK_BASE_URL } from "../../gateway/dist/wechat/client.js";
import { WeChatGateway } from "../../gateway/dist/gateway.js";
import { ControllerClient } from "../../gateway/dist/controller/client.js";

const { values } = parseArgs({
  options: {
    help: { type: "boolean", short: "h" },
    session: { type: "string" },
    chat: { type: "string", default: "synthetic-live-test" },
    node: { type: "string", default: "macair" },
    url: { type: "string", default: "http://127.0.0.1:8790" },
    marker: { type: "string" },
    timeout: { type: "string", default: "90000" },
  },
});

if (values.help) {
  console.log(`Usage: node tests/live/wechat-model.mjs --session ID [--chat CHAT_ID] [--node macair] [--url URL] [--marker MARKER] [--timeout MS]

Synthetic WeChat acceptance simulator for Control Plane.
Validates:
1. Pure fake iLink mock (zero external requests, no real WeChat tokens read or used).
2. Controller natural-language routing & Leader plan proposal.
3. Plan execution confirmation ("确认执行").
4. Precise turn completion polling with exact marker output matching.
5. Inbound message deduplication (replayed message does not trigger duplicate dispatch).
6. Result inquiry verification via simulated chat.
`);
  process.exit(0);
}

if (!values.session) {
  console.error("Error: --session <sessionId> is required");
  process.exit(1);
}

await main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});

async function main() {
  const sessionId = values.session.trim();
  const chatId = values.chat.trim();
  const nodeId = values.node.trim();
  const controllerUrl = values.url.trim();
  const timeoutMs = Number(values.timeout);
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 300000, 'Invalid --timeout');
  const endpoint = new URL(controllerUrl);
  assert(!endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash && !/[?#]/.test(controllerUrl), 'Controller URL must not contain credentials, query parameters, or fragments');
  assert(endpoint.protocol === 'https:' || (endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)), 'Remote Controller requires HTTPS');
  assert(/^synthetic-[a-zA-Z0-9_-]+$/.test(chatId), 'Use a synthetic- test chat ID');
  const uniqueMarker = values.marker || `SYNTH_MARKER_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // Read controllerToken strictly from local.json
  const runtimeConfigPath = new URL("../../.runtime/local.json", import.meta.url);
  if (!existsSync(runtimeConfigPath)) {
    throw new Error(`Runtime config not found at ${runtimeConfigPath}. Run 'node scripts/local.mjs --init' or '--up' first.`);
  }
  const rawRuntime = readFileSync(runtimeConfigPath, "utf8");
  const parsedRuntime = JSON.parse(rawRuntime);
  const controllerToken = parsedRuntime.controllerToken;
  if (!controllerToken || typeof controllerToken !== "string") {
    throw new Error("Missing controllerToken in .runtime/local.json");
  }

  const tmpPrefix = join(tmpdir(), "wechat-synth-model-");
  const tempDir = await mkdtemp(tmpPrefix);

  try {
    const fakeAccountPath = join(tempDir, "fake-wechat-account.json");
    const fakeStatePath = join(tempDir, "fake-gateway.state.json");

    // Pure fake WeChat account credentials: safe synthetic token, never touches real WeChat
    const fakeAccount = {
      token: "mock-synth-wechat-token",
      accountId: "synth_tester_account",
      baseUrl: DEFAULT_ILINK_BASE_URL,
      savedAt: new Date().toISOString(),
    };
    writeFileSync(fakeAccountPath, JSON.stringify(fakeAccount, null, 2) + "\n", { mode: 0o600 });

    // Mock iLink mailbox queue and recording
    const inboundQueue = [];
    const sentReplies = [];

    const mockFetch = async (urlStr, init) => {
      const url = new URL(urlStr);
      const pathname = url.pathname;

      if (pathname.includes("getupdates")) {
        const nextCursor = `cursor_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const msgsToDeliver = inboundQueue.splice(0, inboundQueue.length);

        return {
          ok: true,
          status: 200,
          json: async () => ({
            ret: 0,
            errcode: 0,
            errmsg: "ok",
            get_updates_buf: nextCursor,
            msgs: msgsToDeliver.map((item) => ({
              message_type: 1, // MESSAGE_TYPE_INBOUND_TEXT
              from_user_id: item.chatId,
              client_id: item.messageId,
              create_time_ms: String(Date.now()),
              context_token: `ctx_token_${item.chatId}`,
              item_list: [
                {
                  type: 1, // ITEM_TYPE_TEXT
                  text_item: { text: item.text },
                },
              ],
            })),
          }),
        };
      }

      if (pathname.includes("sendmessage")) {
        const body = JSON.parse(init?.body || "{}");
        const msg = body.msg || {};
        const textItem = msg.item_list?.[0]?.text_item?.text || "";
        sentReplies.push({
          to: msg.to_user_id,
          text: textItem,
          clientId: msg.client_id,
          sentAt: Date.now(),
        });

        return {
          ok: true,
          status: 200,
          json: async () => ({
            ret: 0,
            errcode: 0,
            errmsg: "ok",
          }),
        };
      }

      throw new Error(`Unexpected mock fetch call to ${pathname}`);
    };

    const stateManager = new StateManager(fakeAccountPath, fakeStatePath);
    const ilinkClient = new ILinkClient({
      stateManager,
      configuredBaseUrl: DEFAULT_ILINK_BASE_URL,
      fetchImpl: mockFetch,
    });
    const controllerClient = new ControllerClient({
      controllerUrl,
      controllerToken,
      timeoutMs: 30000,
    });

    const gateway = new WeChatGateway({
      stateManager,
      ilink: ilinkClient,
      controller: controllerClient,
    });
    // The synthetic mailbox is empty; exercise the same explicit startup boundary as production.
    const baseline = await gateway.establishBaseline();
    assert.equal(baseline.rawMessagesSkipped, 0);
    assert.equal(sentReplies.length, 0);
    async function targetSendIds() {
      const response = await fetch(`${controllerUrl}/v1/status`, {
        headers: { Authorization: `Bearer ${controllerToken}` },
        redirect: 'error', signal: AbortSignal.timeout(5000),
      });
      assert(response.ok, `Status query failed: HTTP ${response.status}`);
      const status = await response.json();
      assert.equal(status.leaderMode, 'model', 'A real model-backed Controller is required');
      return status.commands.filter(c => c.nodeId === nodeId && c.sessionId === sessionId && c.action === 'send').map(c => c.commandId).sort();
    }
    const sendsBeforePlan = await targetSendIds();

    console.log(JSON.stringify({
      step: "init",
      session: sessionId,
      node: nodeId,
      chat: chatId,
      marker: uniqueMarker,
    }));

    let msgCounter = 0;
    async function simulateUserMessage(text) {
      msgCounter++;
      const messageId = `synth_msg_${Date.now()}_${msgCounter}`;
      inboundQueue.push({ chatId, messageId, text });
      const beforeSentCount = sentReplies.length;
      const cycle = await gateway.pollOnce();
      const newReplies = sentReplies.slice(beforeSentCount);
      return { messageId, cycle, newReplies };
    }

    console.log("-> Step 1: Sending task instruction to Controller via simulated WeChat...");
    const taskPrompt = `只针对节点 ${nodeId} 的会话 ${sessionId} 制定一个任务计划：仅回复 ${uniqueMarker}，禁止调用工具、读写文件或发送外部消息。不要读取其他会话正文，也不要操作其他会话。`;
    const step1 = await simulateUserMessage(taskPrompt);

    assert(step1.newReplies.length > 0, "Expected gateway to send an outbound reply for step 1");
    const reply1 = step1.newReplies.map((r) => r.text).join("\n");
    console.log(`<- Step 1 Reply: \n${reply1}\n`);

    const hasPlan = reply1.includes("待执行计划") || reply1.includes("确认执行");
    assert(hasPlan, `Step 1 reply should propose a plan or require confirmation. Got: ${reply1}`);
    assert(reply1.includes(sessionId) && reply1.includes(nodeId) && reply1.includes(uniqueMarker), 'Plan must identify the exact target and marker');
    assert.deepEqual(await targetSendIds(), sendsBeforePlan, 'Planning must not dispatch a send');

    console.log("-> Step 2: Confirming plan execution with '确认执行'...");
    const step2 = await simulateUserMessage("确认执行");
    assert(step2.newReplies.length > 0, "Expected gateway to send an outbound reply for step 2");
    const reply2 = step2.newReplies.map((r) => r.text).join("\n");
    console.log(`<- Step 2 Reply: \n${reply2}\n`);

    const cmdMatch = reply2.match(/cmd_[a-f0-9\-]+/i);
    const commandId = cmdMatch ? cmdMatch[0] : null;
    assert(commandId, 'Confirmation did not produce a command ID');

    console.log(`-> Step 3: Polling command for turn completion (commandId: ${commandId || "discovering"})...`);
    const deadline = Date.now() + timeoutMs;
    let finalCommand = null;

    const authHeaders = {
      Authorization: `Bearer ${controllerToken}`,
      "Content-Type": "application/json",
    };

    while (Date.now() < deadline) {
      if (commandId) {
        const cmdRes = await fetch(`${controllerUrl}/v1/commands/${encodeURIComponent(commandId)}`, { headers: authHeaders, redirect: 'error', signal: AbortSignal.timeout(5000) });
        assert(cmdRes.ok, `Command query failed: HTTP ${cmdRes.status}`);
        if (cmdRes.ok) {
          const cmdJson = await cmdRes.json();
          if (["completed", "failed", "uncertain"].includes(cmdJson.status)) {
            finalCommand = cmdJson;
            break;
          }
        }
      }
      await delay(1000);
    }

    if (finalCommand) {
      console.log(JSON.stringify({
        step: "command_finished",
        commandId: finalCommand.commandId,
        status: finalCommand.status,
        turnId: finalCommand.turnId,
        outputPreview: (finalCommand.output || "").slice(0, 300),
      }, null, 2));

      assert.equal(finalCommand.status, "completed", `Command ended in ${finalCommand.status}: ${finalCommand.error || ""}`);
      assert.equal(finalCommand.nodeId, nodeId);
      assert.equal(finalCommand.sessionId, sessionId);
      assert(finalCommand.turnId, "Completed send command must contain turnId");
      assert(
        (finalCommand.output || "").includes(uniqueMarker),
        "Exact completed turn output must contain the unique marker"
      );
    } else {
      throw new Error('Exact turn completion timed out; test failed without replaying send');
    }

    console.log("-> Step 4: Testing inbound message deduplication...");
    const sendsBeforeReplay = await targetSendIds();
    const duplicateMessage = {
      chatId,
      messageId: step1.messageId,
      text: taskPrompt,
    };
    inboundQueue.push(duplicateMessage);
    const beforeDupReplies = sentReplies.length;
    await gateway.pollOnce();
    const afterDupReplies = sentReplies.slice(beforeDupReplies);

    console.log(`<- Step 4 Dedupe replies count: ${afterDupReplies.length}`);
    assert.equal(afterDupReplies.length, 0, "Duplicate inbound message with same deliveryKey should not trigger new reply");
    const replay = await controllerClient.forwardMessage({ chatId, messageId: step2.messageId, text: '确认执行' });
    assert.equal(replay.commandId, commandId, 'Confirmation replay must return the same command');
    assert.deepEqual(await targetSendIds(), sendsBeforeReplay, 'Confirmation replay must not dispatch a new send');

    console.log("-> Step 5: Simulating inquiry about the outcome...");
    const step5 = await simulateUserMessage(`刚才给 ${sessionId} 发送 ${uniqueMarker} 的执行结果怎么样了？`);
    const reply5 = step5.newReplies.map((r) => r.text).join("\n");
    console.log(`<- Step 5 Inquiry Reply: \n${reply5}\n`);
    assert(reply5.includes(uniqueMarker), 'Result reply must contain the completed output marker');
    assert(/completed|已完成|完成了|执行完成/.test(reply5), 'Result reply must report completion');

    console.log(JSON.stringify({
      outcome: "SUCCESS",
      session: sessionId,
      marker: uniqueMarker,
      verifiedDedupe: true,
      verifiedPlanConfirmation: true,
    }, null, 2));

  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
