import { test } from "node:test";
import assert from "node:assert/strict";
import { ControlMcp } from "../../src/leader/control-mcp.js";
import { QueryProgress, QUERY_PROGRESS_LIMIT } from "../../src/leader/progress.js";
import type { ControllerMessageRequest } from "../../src/types.js";
import type { ControllerToolCall, DirectToolClient } from "../../src/controller/direct-tools.js";

const request = { chatId: "chat", messageId: "root", text: "检查目前状态" };
type DirectCall = ControllerToolCall;
function directClient(
  call: (input: DirectCall) => Promise<{ text: string }> = async () => ({ text: "ok" }),
  list: (input: ControllerMessageRequest) => void = () => {},
): DirectToolClient {
  return {
    listTools: async (input: ControllerMessageRequest) => { list(input); return {
      tools: ["inspect_current", "inspect_other"].map(name => ({ name, description: "Inspect current state",
        inputSchema: { type: "object" as const, properties: { arguments: { type: "object" } } },
        annotations: { readOnlyHint: true } })),
      instructions: "", context: { history: [], memories: {} },
    }; },
    callTool: async (input: DirectCall) => ({ result: {}, reply: await call(input) }),
  };
}
function authority(input: DirectCall): ControllerMessageRequest {
  return { chatId: input.chatId, messageId: input.messageId, text: input.text };
}
async function inspect(tool: ControlMcp, name = "inspect_current", requestMessageId?: string) {
  return invoke(tool, name, { arguments: {}, ...(requestMessageId ? { requestMessageId } : {}) });
}
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
  const tool = new ControlMcp(request, directClient(), {
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
  const tool = new ControlMcp(request, directClient(async input => {
    submitted.push(authority(input)); return { text: input.messageId };
  }));
  await tool.start(); t.after(() => tool.close());
  await inspect(tool);
  const steer = { ...request, messageId: "steer", text: "检查，但不要重启" };
  tool.appendRequest(steer); tool.appendRequest(steer);
  steer.text = "tampered";
  const batches = await Promise.all([inspect(tool, "inspect_current", "steer"), inspect(tool, "inspect_current", "steer")]);
  assert.equal(tool.requestCount, 2);
  assert.deepEqual(submitted, [request, { ...request, messageId: "steer", text: "检查，但不要重启" }]);
  assert.ok(tool.result?.text.includes("steer"));
  assert.equal(tool.resultMessageId, "steer");
  assert.ok(batches.every(result => !result.isError));
  assert.throws(() => tool.appendRequest({ ...request, text: "conflicting content" }), /Conflicting/);
  assert.throws(() => tool.appendRequest({ ...request, chatId: "another" }), /another chat/);
});

test("unsubmitted steer corrections reach Controller together before any superseded action executes", async t => {
  const original = { ...request, text: "给会话 A 发消息执行部署\n只执行这次授权" };
  const correction = { ...request, messageId: "correction", text: "改成给 B 查询状态，别发 A，也不要部署" };
  const submitted: ControllerMessageRequest[] = [];
  const listed: ControllerMessageRequest[] = [];
  const tool = new ControlMcp(original, directClient(async input => {
    submitted.push(authority(input)); return { text: "按最新约束仅查询 B" };
  }, input => listed.push(input)));
  await tool.start(); t.after(() => tool.close());
  tool.appendRequest(correction);
  original.text = "tampered"; correction.text = "tampered";
  const results = await Promise.all([inspect(tool, "inspect_current", "correction"), inspect(tool, "inspect_current", "correction")]);
  assert.equal(submitted.length, 1);
  const [batch] = submitted;
  assert.equal(batch.messageId, "correction");
  assert.deepEqual(listed.at(-1), batch);
  assert.equal(Object.isFrozen(listed.at(-1)), true);
  assert.match(batch.text, /后面的消息.*修改、限制或撤销优先/);
  assert.ok(batch.text.includes("给会话 A 发消息执行部署\n只执行这次授权"));
  assert.ok(batch.text.includes("改成给 B 查询状态，别发 A，也不要部署"));
  assert.ok(batch.text.indexOf("给会话 A") < batch.text.indexOf("改成给 B"));
  assert.doesNotMatch(batch.text, /tampered/);
  assert.equal(tool.resultMessageId, "correction");
  assert.ok(results.every(result => !result.isError));
});

test("omitted or stale message identity never inherits appended authority and returns a redacted current request", async t => {
  const submitted: ControllerMessageRequest[] = [];
  const tool = new ControlMcp(request, directClient(async input => {
    submitted.push(authority(input)); return { text: "查询完成" };
  }));
  await tool.start(); t.after(() => tool.close());
  const correction = { ...request, messageId: "corrected", text: "只检查 B，不要部署；链接 #login=private-ticket" };
  tool.appendRequest(correction);
  for (const identity of [undefined, "root"]) {
    const stale = await inspect(tool, "inspect_current", identity);
    assert.equal(stale.isError, true);
    const visible = JSON.parse(stale.content[0].text);
    assert.equal(visible.currentRequest.messageId, "corrected");
    assert.ok(visible.currentRequest.text.includes("只检查 B，不要部署"));
    assert.doesNotMatch(JSON.stringify(visible), /private-ticket/);
  }
  assert.equal(submitted.length, 0);
  assert.equal(tool.wasCalled, false);
  const selected = await inspect(tool, "inspect_current", "corrected");
  assert.equal(selected.isError, undefined);
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].messageId, "corrected");
  assert.ok(submitted[0].text.includes(correction.text));
});

test("superseded queued batches reject old parameters and retain every unsubmitted original for reselection", { timeout: 5000 }, async t => {
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const submitted: ControllerMessageRequest[] = [];
  const tool = new ControlMcp(request, directClient(async input => {
    submitted.push(authority(input));
    if (input.messageId === "root") { entered(); await blocked; }
    return { text: input.messageId };
  }));
  await tool.start(); t.after(() => tool.close());
  const initial = inspect(tool);
  await started;
  tool.appendRequest({ ...request, messageId: "next", text: "再查机器 A" });
  tool.appendRequest({ ...request, messageId: "next-correction", text: "改查机器 B" });
  const second = inspect(tool, "inspect_current", "next-correction");
  // Wait until the second tool freezes its acceptance window, before the first
  // Controller response permits its queued dispatch to start.
  while (!(tool as unknown as { requests: { submitted: boolean }[] }).requests.every(item => item.submitted)) {
    await new Promise(resolve => setImmediate(resolve));
  }
  tool.appendRequest({ ...request, messageId: "later", text: "最后再查机器 C" });
  release();
  const results = await Promise.all([initial, second]);
  assert.equal(results[1].isError, true);
  assert.match(results[1].content[0].text, /本调用未提交执行/);
  assert.equal(submitted.length, 1);
  await inspect(tool, "inspect_current", "later");
  assert.equal(submitted.length, 2);
  assert.equal(submitted[1].messageId, "later");
  assert.ok(submitted[1].text.includes("再查机器 A"));
  assert.ok(submitted[1].text.includes("改查机器 B"));
  assert.ok(submitted[1].text.includes("最后再查机器 C"));
  assert.ok(!submitted[1].text.includes(request.text));
});

test("oversized combined originals are rejected without truncating or executing superseded actions", async t => {
  let submissions = 0;
  const tool = new ControlMcp({ ...request, text: "执行 A" + "前文".repeat(4500) }, directClient(async () => {
    submissions++; return { text: "should not execute" };
  }));
  await tool.start(); t.after(() => tool.close());
  tool.appendRequest({ ...request, messageId: "correction", text: "禁止执行 A，只查询 B" + "后文".repeat(4000) });
  for (let index = 0; index < 2; index++) {
    const result = await inspect(tool, "inspect_current", "correction");
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /均未提交执行/);
  }
  assert.equal(submissions, 0);
  assert.equal(tool.wasCalled, false);
  assert.equal(tool.resultMessageId, undefined);
});

test("unknown Controller outcome is never resubmitted and cannot be hidden by later input", async t => {
  const submitted: string[] = [];
  const tool = new ControlMcp(request, directClient(async input => {
    submitted.push(input.messageId);
    if (input.messageId === "root") throw new Error("secret");
    return { text: "追加消息已处理" };
  }));
  await tool.start(); t.after(() => tool.close());
  const initial = await inspect(tool);
  assert.equal(initial.isError, true);
  tool.appendRequest({ ...request, messageId: "steer", text: "继续查日志" });
  const result = await inspect(tool, "inspect_current", "steer");
  assert.equal(result.isError, undefined);
  await inspect(tool, "inspect_current", "steer");
  assert.deepEqual(submitted, ["root", "steer"]);
  assert.equal(tool.result, undefined);
  assert.equal(tool.resultMessageId, undefined);
});

test("direct business work does not reserve progress slots or block native progress delivery", async t => {
  const sent: string[] = [];
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const tool = new ControlMcp(request, directClient(async () => {
    entered(); await blocked; return { text: "检查完成" };
  }), { progress: async (_text, id) => { sent.push(id); return { sent: true }; } });
  await tool.start(); t.after(() => tool.close());
  await invoke(tool, "report_progress", { text: "正在核对用户指定的范围。" });
  const business = inspect(tool);
  await started;
  try {
    const progress = await invoke(tool, "report_progress", { text: "已核实目标会话，查询记录仍在进行。" });
    assert.equal(JSON.parse(progress.content[0].text).remaining, 1);
    assert.equal(sent.length, 2);
  } finally { release(); }
  await business;
  const last = await invoke(tool, "report_progress", { text: "记录已取得，正在汇总核查结果。" });
  assert.equal(JSON.parse(last.content[0].text).remaining, 0);
  assert.equal(sent.length, 3);
  const replayIds: string[] = [];
  const reconstructed = new QueryProgress(request, async (_text, id) => { replayIds.push(id); return { sent: true }; });
  await reconstructed.report("同一query相同序号有相同delivery identity");
  assert.equal(replayIds[0], sent[0]);
});

test("distinct tools reuse the same immutable original batch without reintroducing an inner model", async t => {
  const submitted: DirectCall[] = [];
  const tool = new ControlMcp(request, directClient(async input => {
    submitted.push(input); return { text: input.name };
  }));
  await tool.start(); t.after(() => tool.close());
  await inspect(tool);
  await inspect(tool, "inspect_other");
  await inspect(tool);
  assert.deepEqual(submitted.map(input => input.name), ["inspect_current", "inspect_other"]);
  assert.deepEqual(submitted.map(authority), [request, request]);
  assert.equal(new Set(submitted.map(input => input.callId)).size, 2);
});

test("new original messages queue after an in-flight Controller request without parallel dispatch", async t => {
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const submitted: string[] = [];
  const tool = new ControlMcp(request, directClient(async input => {
    submitted.push(input.messageId);
    if (input.messageId === "root") { entered(); await blocked; }
    return { text: input.messageId };
  }));
  await tool.start(); t.after(() => tool.close());
  const first = inspect(tool);
  await started;
  tool.appendRequest({ ...request, messageId: "steer", text: "继续查日志" });
  const second = inspect(tool, "inspect_current", "steer");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(submitted, ["root"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(submitted, ["root", "steer"]);
  assert.ok(tool.result?.text.includes("steer"));
});

test("control tools held during native steer reject stale authority before explicit reselection", async t => {
  const submitted: string[] = [];
  const tool = new ControlMcp(request, directClient(async input => {
    submitted.push(input.messageId); return { text: input.messageId };
  }));
  await tool.start(); t.after(() => tool.close());
  const release = tool.beginAppend();
  const secondRelease = tool.beginAppend();
  const first = inspect(tool);
  const second = inspect(tool);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(submitted, []);
  tool.appendRequest({ ...request, messageId: "accepted-steer", text: "继续检查，但不要重启" });
  release(); release();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(submitted, []);
  secondRelease();
  const stale = await Promise.all([first, second]);
  assert.ok(stale.every(result => result.isError));
  assert.deepEqual(submitted, []);
  await inspect(tool, "inspect_current", "accepted-steer");
  assert.deepEqual(submitted, ["accepted-steer"]);
});

test("releasing a rejected native steer grants no extra Controller authority", async t => {
  const submitted: string[] = [];
  const tool = new ControlMcp(request, directClient(async input => {
    submitted.push(input.messageId); return { text: input.messageId };
  }));
  await tool.start(); t.after(() => tool.close());
  const release = tool.beginAppend();
  const waiting = inspect(tool);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(submitted, []);
  release(); await waiting;
  assert.deepEqual(submitted, ["root"]);
  assert.equal(tool.requestCount, 1);
});

test("unknown native steer invalidates held authority instead of submitting the old request", async t => {
  let submissions = 0;
  const tool = new ControlMcp({ ...request, text: "执行部署" }, directClient(async () => {
    submissions++; return { text: "should not execute" };
  }));
  await tool.start(); t.after(() => tool.close());
  const release = tool.beginAppend();
  const waiting = inspect(tool);
  await new Promise(resolve => setImmediate(resolve));
  tool.invalidateAuthority(); release();
  const result = await waiting;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /授权待核实/);
  assert.equal((await inspect(tool)).isError, true);
  assert.equal(submissions, 0);
  assert.equal(tool.result, undefined);
  assert.equal(tool.resultMessageId, undefined);
});

test("invalidated authority drains submitted work but never forwards an already queued batch", { timeout: 5000 }, async t => {
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const submitted: string[] = [];
  const tool = new ControlMcp(request, directClient(async input => {
    submitted.push(input.messageId); entered(); await blocked; return { text: "submitted work settled" };
  }));
  await tool.start(); t.after(() => tool.close());
  const first = inspect(tool);
  await started;
  tool.appendRequest({ ...request, messageId: "queued", text: "额外操作" });
  const second = inspect(tool, "inspect_current", "queued");
  while (!(tool as unknown as { requests: { submitted: boolean }[] }).requests.every(item => item.submitted)) {
    await new Promise(resolve => setImmediate(resolve));
  }
  tool.invalidateAuthority(); release();
  const results = await Promise.all([first, second]);
  assert.ok(results.every(result => result.isError));
  assert.deepEqual(submitted, ["root"]);
  assert.equal(tool.result, undefined);
});


test("a queued mutation rechecks steer holds and the latest accepted identity at its actual dispatch boundary", async t => {
  for (const holdThroughDependency of [false, true]) {
    let releaseQuery!: () => void, entered!: () => void;
    const blocked = new Promise<void>(resolve => { releaseQuery = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const submitted: string[] = [];
    const tool = new ControlMcp({ ...request, text: "查询A后执行B" }, {
      listTools: async () => ({ tools: [
        { name: "query", description: "query", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
        { name: "mutate", description: "mutate", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } },
      ], instructions: "", context: { history: [], memories: {} } }),
      callTool: async input => {
        submitted.push(input.name);
        if (submitted.length === 1) { entered(); await blocked; }
        return { result: { messageId: input.messageId } };
      },
    });
    await tool.start(); t.after(() => tool.close());
    const query = inspect(tool, "query");
    await started;
    const mutation = inspect(tool, "mutate");
    while ((tool as unknown as { pending: number }).pending < 2) await new Promise(resolve => setImmediate(resolve));
    const releaseAppend = tool.beginAppend();
    if (holdThroughDependency) {
      releaseQuery(); await query;
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(submitted, ["query"]);
    }
    tool.appendRequest({ ...request, messageId: "cancel", text: "不要执行B，只继续查询" });
    releaseAppend();
    releaseQuery();
    const results = await Promise.all([query, mutation]);
    assert.equal(results[1].isError, true);
    const rejection = JSON.parse(results[1].content[0].text);
    assert.match(rejection.text, /本调用未提交执行/);
    assert.equal(rejection.currentRequest.messageId, "cancel");
    assert.ok(rejection.currentRequest.text.includes("不要执行B"));
    assert.deepEqual(submitted, ["query"]);
    assert.notEqual(tool.result, undefined, "a proven stale rejection must not make earlier successful queries uncertain");
    await inspect(tool, "query", "cancel");
    assert.deepEqual(submitted, ["query", "query"]);
  }
});
