import { test } from "node:test";
import assert from "node:assert/strict";
import { ControlMcp } from "../../src/leader/control-mcp.js";
import type { ControllerMessageResponse, ControllerMessageRequest } from "../../src/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server as HttpServer } from "node:http";
import { ControllerToolRejectedError, type ControllerTool, type DirectToolClient } from "../../src/controller/direct-tools.js";

const schema: ControllerTool = { name: "inspect_current", description: "inspect current request",
  inputSchema: { type: "object", properties: { arguments: { type: "object", properties: {}, additionalProperties: false } },
    required: ["arguments"], additionalProperties: false }, annotations: { readOnlyHint: true } };
function replyClient(forwardMessage: (input: ControllerMessageRequest) => Promise<ControllerMessageResponse>): DirectToolClient {
  return { listTools: async () => ({ tools: [schema], instructions: "current-request rules" }),
    callTool: async input => ({ result: {}, reply: await forwardMessage({ chatId: input.chatId, messageId: input.messageId, text: input.text }) }) };
}

async function call(tool: ControlMcp, method: string, params?: unknown, token = tool.token) {
  return fetch(tool.url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
}

test("MCP binds immutable current user request and forwards only once for concurrent or repeated calls", async t => {
  const request = { chatId: "chat", messageId: "message", text: "修好这个问题，不部署" };
  const submitted: ControllerMessageRequest[] = [];
  const tool = new ControlMcp(request, replyClient(async input => {
    submitted.push(input);
    return { text: "已派发", commandId: "cmd-1" };
  }));
  await tool.start();
  t.after(() => tool.close());
  request.text = "tampered";
  assert.equal(new URL(tool.url).hostname, "127.0.0.1");
  const initialized = await (await call(tool, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } })).json() as any;
  assert.equal(initialized.result.protocolVersion, "2025-03-26");
  const tools = await (await call(tool, "tools/list")).json() as any;
  const advertised = tools.result.tools[0].inputSchema;
  assert.equal(advertised.properties.requestMessageId.type, "string");
  delete advertised.properties.requestMessageId;
  assert.deepEqual(advertised, schema.inputSchema);
  const params = { name: "inspect_current", arguments: { arguments: {} } };
  const responses = await Promise.all([call(tool, "tools/call", params), call(tool, "tools/call", params)]);
  for (const response of responses) assert.equal(response.status, 200);
  assert.deepEqual(submitted, [{ chatId: "chat", messageId: "message", text: "修好这个问题，不部署" }]);
  assert.deepEqual(tool.result, { text: "已派发", commandId: "cmd-1" });
});

test("MCP rejects credentials, alternate tools, rewritten input, excessive bodies and other methods", async t => {
  let calls = 0;
  const tool = new ControlMcp({ chatId: "c", messageId: "m", text: "x" }, replyClient(async () => { calls++; return { text: "ok" }; }));
  await tool.start();
  t.after(() => tool.close());
  assert.equal((await call(tool, "tools/list", {}, "wrong")).status, 401);
  assert.equal((await fetch(tool.url, { headers: { Authorization: `Bearer ${tool.token}` } })).status, 405);
  const rewritten = await (await call(tool, "tools/call", {
    name: "inspect_current", arguments: { text: "deploy" },
  })).json() as any;
  assert.equal(rewritten.error.code, -32602);
  const alternative = await (await call(tool, "tools/call", { name: "run_shell", arguments: {} })).json() as any;
  assert.equal(alternative.error.code, -32602);
  assert.equal((await call(tool, "tools/call", { name: "x".repeat(1024 * 1024) })).status, 413);
  assert.equal(calls, 0);
});

test("MCP failure is sanitized and never retried; closing removes turn endpoint", async () => {
  let calls = 0;
  const tool = new ControlMcp({ chatId: "c", messageId: "m", text: "x" }, replyClient(async () => { calls++; throw new Error("secret-token stderr"); }));
  await tool.start();
  for (let index = 0; index < 2; index++) {
    const response = await (await call(tool, "tools/call", { name: "inspect_current", arguments: { arguments: {} } })).text();
    assert.match(response, /isError/);
    assert.doesNotMatch(response, /secret-token/);
  }
  assert.equal(calls, 1);
  assert.equal(tool.wasCalled, true);
  assert.equal(tool.result, undefined);
  await tool.close();
  await assert.rejects(fetch(tool.url));
});

test("console credentials stay on the delivery sideband and never enter MCP model content", async t => {
  const text = "打开控制台：https://console.example/#login=one.time-secret_012%2F";
  const tool = new ControlMcp({ chatId: "c", messageId: "m", text: "打开控制台" }, replyClient(async () => ({ text })));
  await tool.start();
  t.after(() => tool.close());
  const response = await (await call(tool, "tools/call", { name: "inspect_current", arguments: { arguments: {} } })).text();
  assert.doesNotMatch(response, /one.time-secret/);
  assert.match(response, /#login=\[REDACTED\]/);
  assert.equal(tool.result?.text, text);
  assert.equal(tool.wasCalled, true);
});

test("official MCP client negotiates protocol and invokes the stateless turn tool", async t => {
  const tool = new ControlMcp({ chatId: "c", messageId: "m", text: "查状态" }, replyClient(async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
      return { text: "running" };
    }));
  await tool.start();
  t.after(() => tool.close());
  const client = new Client({ name: "integration-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(tool.url), {
    requestInit: { headers: { Authorization: `Bearer ${tool.token}` } },
  }));
  try {
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 2);
    const result = await client.callTool({ name: listed.tools[0].name, arguments: { arguments: {} } });
    const visible = JSON.parse((result.content as { text: string }[])[0].text);
    assert.deepEqual(visible.result, {});
    assert.deepEqual(visible.reply, { text: "running" });
    assert.equal(visible.currentRequest.messageId, "m");
  } finally { await client.close(); }
});

test("shutdown errors cannot finish cleanup while a submitted Controller command is still active", async t => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let submitted!: () => void;
  const entered = new Promise<void>(resolve => { submitted = resolve; });
  const tool = new ControlMcp({ chatId: "c", messageId: "m", text: "执行当前任务" }, replyClient(async () => { submitted(); await blocked; return { text: "terminal" }; }));
  await tool.start();
  const request = call(tool, "tools/call", { name: "inspect_current", arguments: { arguments: {} } })
    .then(() => "response", () => "disconnected");
  await entered;
  const originalClose = HttpServer.prototype.close;
  t.after(() => { HttpServer.prototype.close = originalClose; });
  HttpServer.prototype.close = function(callback) {
    return originalClose.call(this, error => callback?.(error ?? new Error("synthetic-secret-shutdown-failure")));
  };
  let finished = false;
  const closing = tool.close().then(() => { finished = true; return undefined; }, error => {
    finished = true; return error as Error;
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  release();
  const error = await closing;
  assert.equal(error?.message, "Control tool shutdown failed");
  assert.equal(tool.result?.text, "terminal");
  await request;
});

test("direct tools freeze discovery, parallelize reads, deduplicate canonical calls and serialize mutations", async t => {
  let releaseReads!: () => void;
  const blocked = new Promise<void>(resolve => { releaseReads = resolve; });
  const tools = [schema, { ...schema, name: "mutate", annotations: { readOnlyHint: false } }];
  const entered: string[] = [];
  const calls: Parameters<DirectToolClient["callTool"]>[0][] = [];
  const tool = new ControlMcp({ chatId: "c", messageId: "m", text: "查询并更新" }, {
    listTools: async () => ({ tools, instructions: "rules" }),
    callTool: async request => {
      calls.push(request);
      entered.push(request.name + String(request.arguments.index));
      if (request.name === schema.name) await blocked;
      return { result: { index: request.arguments.index } };
    },
  });
  await tool.start();
  t.after(() => tool.close());
  tools.push({ ...schema, name: "new_authority" });
  assert.deepEqual(tool.toolNames, [schema.name, "mutate", "report_progress"]);
  const invoke = (name: string, arguments_: Record<string, unknown>) =>
    call(tool, "tools/call", { name, arguments: { arguments: arguments_ } });
  const first = invoke(schema.name, { index: 1, other: 2 });
  const duplicate = invoke(schema.name, { other: 2, index: 1 });
  const second = invoke(schema.name, { index: 2 });
  const deadline = Date.now() + 2000;
  while (entered.length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(entered, ["inspect_current1", "inspect_current2"]);
  const mutation = invoke("mutate", { index: 3 });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(entered.length, 2);
  assert.equal(tool.result, undefined);
  releaseReads();
  await Promise.all([first, duplicate, second, mutation]);
  assert.deepEqual(entered, ["inspect_current1", "inspect_current2", "mutate3"]);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(value => value.chatId === "c" && value.messageId === "m" && value.text === "查询并更新"));
  assert.equal(new Set(calls.map(value => value.callId)).size, 3);
  assert.equal(tool.authoritativeText, false);
  assert.deepEqual(tool.result, { text: "" });
  tool.seal();
  const late = await (await invoke(schema.name, { index: 4 })).json() as any;
  assert.equal(late.error.code, -32602);
  assert.equal(calls.length, 3);
});

test("a mutation invalidates a cached read so a later query observes fresh Controller state", async t => {
  const tools = [
    { ...schema, name: "inspect_current", annotations: { readOnlyHint: true } },
    { ...schema, name: "mutate", annotations: { readOnlyHint: false } },
  ];
  const calls: string[] = [];
  const tool = new ControlMcp({ chatId: "c", messageId: "m", text: "查询并更新" }, {
    listTools: async () => ({ tools, instructions: "" }),
    callTool: async input => { calls.push(input.name); return { result: { observed: calls.length } }; },
  });
  await tool.start();
  t.after(() => tool.close());
  const invoke = (name: string) => call(tool, "tools/call", { name, arguments: { arguments: {} } });
  await invoke("inspect_current");
  await invoke("mutate");
  await invoke("inspect_current");
  assert.deepEqual(calls, ["inspect_current", "mutate", "inspect_current"]);
});


test("MCP accepts the largest escaped background prompt within the Controller HTTP budget", async t => {
  let received = "";
  const tool = new ControlMcp({ chatId: "c", messageId: "m", text: "后台任务" }, {
    listTools: async () => ({ tools: [schema], instructions: "rules" }),
    callTool: async input => { received = String(input.arguments.prompt); return { result: {} }; },
  });
  await tool.start();
  t.after(() => tool.close());
  const prompt = "\u0000".repeat(128000);
  const result = await (await call(tool, "tools/call", { name: schema.name,
    arguments: { arguments: { prompt }, authorization: { intent: "isolated_background", backgroundOperations: ["follow_up"] } } })).json() as any;
  assert.equal(result.error, undefined);
  assert.equal(received.length, 128000);
});


test("mixed query and business receipts remain distinguishable and preserve exactly one raw console segment", async t => {
  const consoleText = "控制台 https://console.invalid/#login=synthetic-mixed-secret";
  const tool = new ControlMcp({ chatId: "c", messageId: "m", text: "查A进度并打开控制台" }, {
    listTools: async () => ({ tools: [schema], instructions: "" }),
    callTool: async request => request.arguments.index === 1 ? { result: { progress: "running" } }
      : { result: {}, reply: { text: consoleText } },
  });
  await tool.start(); t.after(() => tool.close());
  const invoke = (index: number) => call(tool, "tools/call", { name: schema.name, arguments: { arguments: { index } } });
  await invoke(1);
  assert.equal(tool.hasQueryResults, true);
  assert.equal(tool.authoritativeText, false);
  assert.equal(tool.consoleText, undefined);
  const response = await (await invoke(2)).text();
  assert.doesNotMatch(response, /synthetic-mixed-secret/);
  assert.equal(tool.authoritativeText, true);
  assert.equal(tool.hasQueryResults, true);
  assert.equal(tool.consoleText, consoleText);
  assert.deepEqual(tool.result, { text: consoleText });
});

test("only proven pre-execution rejection retains prior successful receipts; uncertain failures block delivery", async t => {
  for (const proven of [true, false]) {
    const tool = new ControlMcp({ chatId: "c", messageId: "m", text: "执行两项任务" }, {
      listTools: async () => ({ tools: [schema], instructions: "" }),
      callTool: async request => {
        if (request.arguments.index === 1) return { result: {}, reply: { text: "第一项已接收", commandId: "cmd-1" } };
        throw proven ? new ControllerToolRejectedError(409) : new Error("secret transport failure");
      },
    });
    await tool.start(); t.after(() => tool.close());
    const invoke = (index: number) => call(tool, "tools/call", { name: schema.name, arguments: { arguments: { index } } });
    await invoke(1);
    const response = await (await invoke(2)).text();
    assert.doesNotMatch(response, /secret transport failure/);
    if (proven) {
      assert.match(response, /本调用未执行/);
      assert.deepEqual(tool.result, { text: "第一项已接收", commandId: "cmd-1" });
      assert.equal(tool.hasQueryResults, true);
    } else assert.equal(tool.result, undefined);
  }
});

test("sideband image aggregation deduplicates ids and refuses conflicts or more than three images", async t => {
  const image = (id: string) => ({ id, mime: "image/png" as const, size: 1, sha256: "a".repeat(64) });
  for (const outcome of ["deduplicated", "overflow", "conflict"] as const) {
    const tool = new ControlMcp({ chatId: "c", messageId: "m", text: "发送图片" }, {
      listTools: async () => ({ tools: [schema], instructions: "" }),
      callTool: async request => ({ result: {}, reply: { text: "图片已准备", images: request.arguments.index === 1
        ? [image("1"), image("2")] : outcome === "deduplicated" ? [image("2"), image("3")]
          : outcome === "overflow" ? [image("3"), image("4")] : [{ ...image("2"), size: 2 }] } }),
    });
    await tool.start(); t.after(() => tool.close());
    const invoke = (index: number) => call(tool, "tools/call", { name: schema.name, arguments: { arguments: { index } } });
    await invoke(1);
    const response = await (await invoke(2)).json() as any;
    if (outcome === "deduplicated") {
      assert.equal(response.result.isError, undefined);
      assert.deepEqual(tool.result?.images?.map(value => value.id), ["1", "2", "3"]);
    } else {
      assert.equal(response.result.isError, true);
      assert.equal(tool.result, undefined);
    }
  }
});

test("multiple credential replies are rejected rather than creating an unrecoverable delivery", async t => {
  const tool = new ControlMcp({ chatId: "c", messageId: "m", text: "控制台" }, {
    listTools: async () => ({ tools: [schema], instructions: "" }),
    callTool: async request => ({ result: {}, reply: { text: `控制台 #login=synthetic-${request.arguments.index}` } }),
  });
  await tool.start(); t.after(() => tool.close());
  const invoke = (index: number) => call(tool, "tools/call", { name: schema.name, arguments: { arguments: { index } } });
  await invoke(1);
  const response = await (await invoke(2)).json() as any;
  assert.equal(response.result.isError, true);
  assert.equal(tool.result, undefined);
});

test("appended queries retain the original credential source and reject a second asset source before submission", async t => {
  const root = { chatId: "c", messageId: "root", text: "打开控制台" };
  const consoleText = "控制台 https://console.invalid/#login=synthetic-original-source";
  const submitted: { name: string; messageId: string; arguments: Record<string, unknown> }[] = [];
  const tools = [schema, { ...schema, name: "get_console_link", annotations: { readOnlyHint: false } },
    { ...schema, name: "send_session_images", annotations: { readOnlyHint: false } }];
  const tool = new ControlMcp(root, { listTools: async () => ({ tools, instructions: "" }), callTool: async input => {
    submitted.push({ name: input.name, messageId: input.messageId, arguments: input.arguments });
    return input.name === "get_console_link" ? { result: {}, reply: { text: consoleText } } : { result: { status: "running" } };
  } });
  await tool.start(); t.after(() => tool.close());
  await call(tool, "tools/call", { name: "get_console_link", arguments: { arguments: {} } });
  tool.appendRequest({ ...root, messageId: "steer", text: "再查询A进度，顺便发图" });
  await call(tool, "tools/call", { name: schema.name, arguments: { arguments: {}, requestMessageId: "steer" } });
  assert.equal(tool.resultMessageId, "root");
  assert.equal(tool.consoleText, consoleText);
  const rejected = await (await call(tool, "tools/call", { name: "send_session_images",
    arguments: { arguments: {}, requestMessageId: "steer", authorization: { intent: "query", sendImages: true } } })).json() as any;
  assert.equal(rejected.result.isError, true);
  assert.match(rejected.result.content[0].text, /本调用未提交执行/);
  assert.match(rejected.result.content[0].text, /来源冲突/);
  assert.deepEqual(submitted, [{ name: "get_console_link", messageId: "root", arguments: {} },
    { name: schema.name, messageId: "steer", arguments: {} }]);
  assert.equal(tool.result?.text, consoleText);
  assert.equal(tool.resultMessageId, "root");
  assert.equal(tool.hasQueryResults, true);
});

test("a later plain receipt cannot change the message identity used to download earlier images", async t => {
  const root = { chatId: "c", messageId: "root", text: "发送图片" };
  const image = { id: "image-1", mime: "image/png" as const, size: 1, sha256: "a".repeat(64) };
  const tools = [schema, { ...schema, name: "send_session_images", annotations: { readOnlyHint: false } }];
  const tool = new ControlMcp(root, { listTools: async () => ({ tools, instructions: "" }), callTool: async input =>
    ({ result: {}, reply: input.name === "send_session_images" ? { text: "图片已准备", images: [image] } : { text: "新任务已接收", commandId: "cmd-next" } }) });
  await tool.start(); t.after(() => tool.close());
  await call(tool, "tools/call", { name: "send_session_images", arguments: { arguments: {} } });
  tool.appendRequest({ ...root, messageId: "steer", text: "再执行一个独立任务" });
  await call(tool, "tools/call", { name: schema.name, arguments: { arguments: {}, requestMessageId: "steer" } });
  assert.equal(tool.resultMessageId, "root");
  assert.deepEqual(tool.result?.images, [image]);
  assert.equal(tool.result?.commandId, "cmd-next");
  assert.match(tool.result!.text, /图片已准备[\s\S]*新任务已接收/);
});
