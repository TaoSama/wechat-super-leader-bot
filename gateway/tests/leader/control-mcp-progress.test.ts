import { test } from "node:test";
import assert from "node:assert/strict";
import { ControlMcp } from "../../src/leader/control-mcp.js";
import { QueryProgress, QUERY_PROGRESS_LIMIT } from "../../src/leader/progress.js";
import type { ControllerMessageRequest } from "../../src/types.js";

const request = { chatId: "chat", messageId: "root", text: "检查目前状态" };
async function invoke(tool: ControlMcp, name: string, args: unknown = {}) {
  const response = await fetch(tool.url, { method: "POST", headers: { Authorization: `Bearer ${tool.token}`,
    "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  const data = await response.json() as any;
  return data.result;
}

test("progress tool sends model text unchanged, shares three slots across steered input and reports the remainder", async t => {
  const delivered: { text: string; id: string }[] = [];
  let concurrent = 0, maxConcurrent = 0;
  const tool = new ControlMcp(request, { forwardMessage: async () => ({ text: "ok" }) }, {
    progress: async (text, id) => {
      maxConcurrent = Math.max(maxConcurrent, ++concurrent);
      await new Promise(resolve => setImmediate(resolve));
      delivered.push({ text, id });
      concurrent--;
      return { sent: true };
    },
  });
  await tool.start(); t.after(() => tool.close());
  const first = await invoke(tool, "report_progress", { text: "已核实 2 个服务；数据库检查仍在进行。" });
  assert.deepEqual(JSON.parse(first.content[0].text), { sent: true, status: "sent", used: 1, remaining: 2, limit: 3 });
  tool.appendRequest({ ...request, messageId: "steer", text: "顺便看看日志" });
  const results = await Promise.all(Array.from({ length: 5 }, (_, index) => invoke(tool, "report_progress", { text: `发现 ${index}` })));
  const parsed = results.map(result => JSON.parse(result.content[0].text));
  assert.equal(delivered.length, QUERY_PROGRESS_LIMIT);
  assert.equal(delivered[0].text, "已核实 2 个服务；数据库检查仍在进行。");
  assert.equal(maxConcurrent, 1);
  assert.equal(new Set(delivered.map(item => item.id)).size, 3);
  assert.equal(parsed.filter(result => result.status === "limit_reached").length, 3);
  assert.equal(parsed.at(-1).remaining, 0);
});

test("failed and unknown sends consume allowance without exposing secrets or retrying", async () => {
  let calls = 0;
  const progress = new QueryProgress(request, async () => {
    calls++;
    if (calls === 1) throw new Error("private-token provider stderr");
    return { sent: false, reason: "https://secret.example/?token=private" };
  });
  const invalid = await progress.report(" ");
  assert.equal(invalid.used, 0);
  for (let index = 0; index < 4; index++) {
    const result = await progress.report("已完成当前检查，正在核实下一项。");
    assert.equal(result.sent, false);
    assert.doesNotMatch(JSON.stringify(result), /private|secret|provider/);
  }
  assert.equal(calls, 3);
  const recreated = new QueryProgress(request, async (_text, id) => {
    assert.equal(id.endsWith(":1"), true); return { sent: true };
  });
  await recreated.report("stable identity");
});

test("exhausted transport budget reports zero sendable updates and does not attempt further sends", async () => {
  for (const reason of ["budget_exhausted", "window_expired"]) {
    let calls = 0;
    const progress = new QueryProgress(request, async () => { calls++; return { sent: false, reason }; });
    assert.deepEqual(await progress.report("有事实可报告"), {
      sent: false, status: "not_sent", used: 1, remaining: 0, limit: 3, reason,
    });
    assert.equal((await progress.report("另一项进展")).remaining, 0);
    assert.equal(calls, 1);
  }
});

test("Controller receives each immutable original input once even after repeated calls and additional steer", async t => {
  const submitted: ControllerMessageRequest[] = [];
  const tool = new ControlMcp(request, { forwardMessage: async input => {
    submitted.push(input); return { text: input.messageId };
  } });
  await tool.start(); t.after(() => tool.close());
  await invoke(tool, "control_current_request");
  const steer = { ...request, messageId: "steer", text: "检查，但不要重启" };
  tool.appendRequest(steer); tool.appendRequest(steer);
  steer.text = "tampered";
  const batches = await Promise.all([invoke(tool, "control_current_request"), invoke(tool, "control_current_request")]);
  assert.equal(tool.requestCount, 2);
  assert.deepEqual(submitted, [request, { ...request, messageId: "steer", text: "检查，但不要重启" }]);
  assert.equal(tool.result?.text, "steer");
  assert.equal(tool.resultMessageId, "steer");
  const visible = JSON.parse(batches[0].content[0].text);
  assert.deepEqual(visible.responses, [{ messageId: "root", reply: { text: "root" } }, { messageId: "steer", reply: { text: "steer" } }]);
  assert.throws(() => tool.appendRequest({ ...request, text: "conflicting content" }), /Conflicting/);
  assert.throws(() => tool.appendRequest({ ...request, chatId: "another" }), /another chat/);
});

test("unsubmitted steer corrections reach Controller together before any superseded action executes", async t => {
  const original = { ...request, text: "给会话 A 发消息执行部署\n只执行这次授权" };
  const correction = { ...request, messageId: "correction", text: "改成给 B 查询状态，别发 A，也不要部署" };
  const submitted: ControllerMessageRequest[] = [];
  const tool = new ControlMcp(original, { forwardMessage: async input => {
    submitted.push(input); return { text: "按最新约束仅查询 B" };
  } });
  await tool.start(); t.after(() => tool.close());
  tool.appendRequest(correction);
  original.text = "tampered"; correction.text = "tampered";
  const results = await Promise.all([invoke(tool, "control_current_request"), invoke(tool, "control_current_request")]);
  assert.equal(submitted.length, 1);
  const [batch] = submitted;
  assert.equal(batch.messageId, "correction");
  assert.equal(Object.isFrozen(batch), true);
  assert.match(batch.text, /后面的消息.*修改、限制或撤销优先/);
  assert.ok(batch.text.includes("给会话 A 发消息执行部署\n只执行这次授权"));
  assert.ok(batch.text.includes("改成给 B 查询状态，别发 A，也不要部署"));
  assert.ok(batch.text.indexOf("给会话 A") < batch.text.indexOf("改成给 B"));
  assert.doesNotMatch(batch.text, /tampered/);
  assert.equal(tool.resultMessageId, "correction");
  const visible = JSON.parse(results[0].content[0].text);
  assert.deepEqual(visible.responses, [{ messageId: "correction", reply: { text: "按最新约束仅查询 B" } }]);
});

test("new batches exclude already submitted messages and remain frozen while dispatch is queued", { timeout: 5000 }, async t => {
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const submitted: ControllerMessageRequest[] = [];
  const tool = new ControlMcp(request, { forwardMessage: async input => {
    submitted.push(input);
    if (input.messageId === "root") { entered(); await blocked; }
    return { text: input.messageId };
  } });
  await tool.start(); t.after(() => tool.close());
  const initial = invoke(tool, "control_current_request");
  await started;
  tool.appendRequest({ ...request, messageId: "next", text: "再查机器 A" });
  tool.appendRequest({ ...request, messageId: "next-correction", text: "改查机器 B" });
  const second = invoke(tool, "control_current_request");
  // Wait until the second tool freezes its acceptance window, before the first
  // Controller response permits its queued dispatch to start.
  while (!(tool as unknown as { requests: { submitted: boolean }[] }).requests.every(item => item.submitted)) {
    await new Promise(resolve => setImmediate(resolve));
  }
  tool.appendRequest({ ...request, messageId: "later", text: "最后再查机器 C" });
  release(); await Promise.all([initial, second]);
  assert.equal(submitted.length, 2);
  assert.ok(submitted[1].text.includes("再查机器 A"));
  assert.ok(submitted[1].text.includes("改查机器 B"));
  assert.ok(!submitted[1].text.includes(request.text));
  assert.ok(!submitted[1].text.includes("最后再查机器 C"));
  await invoke(tool, "control_current_request");
  assert.deepEqual(submitted[2], { ...request, messageId: "later", text: "最后再查机器 C" });
});

test("oversized combined originals are rejected without truncating or executing superseded actions", async t => {
  let submissions = 0;
  const tool = new ControlMcp({ ...request, text: "执行 A" + "前文".repeat(4500) }, { forwardMessage: async () => {
    submissions++; return { text: "should not execute" };
  } });
  await tool.start(); t.after(() => tool.close());
  tool.appendRequest({ ...request, messageId: "correction", text: "禁止执行 A，只查询 B" + "后文".repeat(4000) });
  for (let index = 0; index < 2; index++) {
    const result = await invoke(tool, "control_current_request");
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /均未提交执行/);
  }
  assert.equal(submissions, 0);
  assert.equal(tool.wasCalled, false);
  assert.equal(tool.resultMessageId, undefined);
});

test("unknown Controller outcome is never resubmitted and cannot be hidden by later input", async t => {
  const submitted: string[] = [];
  const tool = new ControlMcp(request, { forwardMessage: async input => {
    submitted.push(input.messageId);
    if (input.messageId === "root") throw new Error("secret");
    return { text: "追加消息已处理" };
  } });
  await tool.start(); t.after(() => tool.close());
  const initial = await invoke(tool, "control_current_request");
  assert.equal(initial.isError, true);
  tool.appendRequest({ ...request, messageId: "steer", text: "继续查日志" });
  const result = await invoke(tool, "control_current_request");
  assert.equal(result.isError, undefined);
  await invoke(tool, "control_current_request");
  assert.deepEqual(submitted, ["root", "steer"]);
  assert.equal(tool.result, undefined);
  assert.equal(tool.resultMessageId, undefined);
});

test("Controller streamed progress and native progress tools share one root query allowance", async t => {
  const sent: string[] = [];
  const tool = new ControlMcp(request, { forwardMessage: async (_request, options) => {
    assert.equal(options?.progressRemaining, 2);
    await options!.onProgress("已核实目标会话，正在查询执行记录。", "controller-update-1");
    await options!.onProgress("执行记录已取得，正在检查回执。", "controller-update-2");
    const exhausted = await options!.onProgress("这条不应发送", "controller-update-3");
    assert.equal(exhausted.sent, false);
    return { text: "检查完成" };
  } }, { progress: async (text, id) => { sent.push(id); return { sent: true }; } });
  await tool.start(); t.after(() => tool.close());
  await invoke(tool, "report_progress", { text: "正在核对用户指定的范围。" });
  await invoke(tool, "control_current_request");
  const result = await invoke(tool, "report_progress", { text: "这条也不应发送" });
  assert.equal(JSON.parse(result.content[0].text).remaining, 0);
  assert.equal(sent.length, 3);
  const replayIds: string[] = [];
  const reconstructed = new QueryProgress(request, async (_text, id) => { replayIds.push(id); return { sent: true }; });
  await reconstructed.report("同一query相同序号有相同delivery identity");
  assert.equal(replayIds[0], sent[0]);
});

test("Controller model owns its advertised remaining slots until its stream completes", async () => {
  const delivered: string[] = [];
  const progress = new QueryProgress(request, async text => { delivered.push(text); return { sent: true }; });
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const controller = progress.withController(async (remaining, report) => {
    assert.equal(remaining, 3); entered(); await blocked;
    for (let index = 0; index < remaining; index++) assert.equal((await report(`controller ${index}`)).sent, true);
  });
  await started;
  const native = progress.report("native update");
  assert.deepEqual(delivered, []);
  release(); await controller;
  assert.equal((await native).status, "limit_reached");
  assert.deepEqual(delivered, ["controller 0", "controller 1", "controller 2"]);
});

test("new original messages queue after an in-flight Controller request without parallel dispatch", async t => {
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const submitted: string[] = [];
  const tool = new ControlMcp(request, { forwardMessage: async input => {
    submitted.push(input.messageId);
    if (input.messageId === "root") { entered(); await blocked; }
    return { text: input.messageId };
  } });
  await tool.start(); t.after(() => tool.close());
  const first = invoke(tool, "control_current_request");
  await started;
  tool.appendRequest({ ...request, messageId: "steer", text: "继续查日志" });
  const second = invoke(tool, "control_current_request");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(submitted, ["root"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(submitted, ["root", "steer"]);
  assert.equal(tool.result?.text, "steer");
});

test("control tools wait for native steer acceptance before selecting original message authority", async t => {
  const submitted: string[] = [];
  const tool = new ControlMcp(request, { forwardMessage: async input => {
    submitted.push(input.messageId); return { text: input.messageId };
  } });
  await tool.start(); t.after(() => tool.close());
  const release = tool.beginAppend();
  const secondRelease = tool.beginAppend();
  const first = invoke(tool, "control_current_request");
  const second = invoke(tool, "control_current_request");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(submitted, []);
  tool.appendRequest({ ...request, messageId: "accepted-steer", text: "继续检查，但不要重启" });
  release(); release();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(submitted, []);
  secondRelease();
  await Promise.all([first, second]);
  assert.deepEqual(submitted, ["accepted-steer"]);
});

test("releasing a rejected native steer grants no extra Controller authority", async t => {
  const submitted: string[] = [];
  const tool = new ControlMcp(request, { forwardMessage: async input => {
    submitted.push(input.messageId); return { text: input.messageId };
  } });
  await tool.start(); t.after(() => tool.close());
  const release = tool.beginAppend();
  const waiting = invoke(tool, "control_current_request");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(submitted, []);
  release(); await waiting;
  assert.deepEqual(submitted, ["root"]);
  assert.equal(tool.requestCount, 1);
});

test("unknown native steer invalidates held authority instead of submitting the old request", async t => {
  let submissions = 0;
  const tool = new ControlMcp({ ...request, text: "执行部署" }, { forwardMessage: async () => {
    submissions++; return { text: "should not execute" };
  } });
  await tool.start(); t.after(() => tool.close());
  const release = tool.beginAppend();
  const waiting = invoke(tool, "control_current_request");
  await new Promise(resolve => setImmediate(resolve));
  tool.invalidateAuthority(); release();
  const result = await waiting;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /授权待核实/);
  assert.equal((await invoke(tool, "control_current_request")).isError, true);
  assert.equal(submissions, 0);
  assert.equal(tool.result, undefined);
  assert.equal(tool.resultMessageId, undefined);
});

test("invalidated authority drains submitted work but never forwards an already queued batch", { timeout: 5000 }, async t => {
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const submitted: string[] = [];
  const tool = new ControlMcp(request, { forwardMessage: async input => {
    submitted.push(input.messageId); entered(); await blocked; return { text: "submitted work settled" };
  } });
  await tool.start(); t.after(() => tool.close());
  const first = invoke(tool, "control_current_request");
  await started;
  tool.appendRequest({ ...request, messageId: "queued", text: "额外操作" });
  const second = invoke(tool, "control_current_request");
  while (!(tool as unknown as { requests: { submitted: boolean }[] }).requests.every(item => item.submitted)) {
    await new Promise(resolve => setImmediate(resolve));
  }
  tool.invalidateAuthority(); release();
  const results = await Promise.all([first, second]);
  assert.ok(results.every(result => result.isError));
  assert.deepEqual(submitted, ["root"]);
  assert.equal(tool.result, undefined);
});
