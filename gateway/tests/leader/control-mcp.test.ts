import { test } from "node:test";
import assert from "node:assert/strict";
import { ControlMcp } from "../../src/leader/control-mcp.js";
import type { ControllerMessageRequest } from "../../src/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server as HttpServer } from "node:http";

async function call(tool: ControlMcp, method: string, params?: unknown, token = tool.token) {
  return fetch(tool.url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
}

test("MCP binds immutable current user request and forwards only once for concurrent or repeated calls", async t => {
  const request = { chatId: "chat", messageId: "message", text: "修好这个问题，不部署" };
  const submitted: ControllerMessageRequest[] = [];
  const tool = new ControlMcp(request, { forwardMessage: async input => {
    submitted.push(input);
    return { text: "已派发", commandId: "cmd-1" };
  } });
  await tool.start();
  t.after(() => tool.close());
  request.text = "tampered";
  assert.equal(new URL(tool.url).hostname, "127.0.0.1");
  const initialized = await (await call(tool, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } })).json() as any;
  assert.equal(initialized.result.protocolVersion, "2025-03-26");
  const tools = await (await call(tool, "tools/list")).json() as any;
  assert.deepEqual(tools.result.tools[0].inputSchema, { type: "object", properties: {}, additionalProperties: false });
  const params = { name: "control_current_request", arguments: {} };
  const responses = await Promise.all([call(tool, "tools/call", params), call(tool, "tools/call", params)]);
  for (const response of responses) assert.equal(response.status, 200);
  assert.deepEqual(submitted, [{ chatId: "chat", messageId: "message", text: "修好这个问题，不部署" }]);
  assert.deepEqual(tool.result, { text: "已派发", commandId: "cmd-1" });
});

test("MCP rejects credentials, alternate tools, rewritten input, excessive bodies and other methods", async t => {
  let calls = 0;
  const tool = new ControlMcp({ chatId: "c", messageId: "m", text: "x" }, {
    forwardMessage: async () => { calls++; return { text: "ok" }; },
  });
  await tool.start();
  t.after(() => tool.close());
  assert.equal((await call(tool, "tools/list", {}, "wrong")).status, 401);
  assert.equal((await fetch(tool.url, { headers: { Authorization: `Bearer ${tool.token}` } })).status, 405);
  const rewritten = await (await call(tool, "tools/call", {
    name: "control_current_request", arguments: { text: "deploy" },
  })).json() as any;
  assert.equal(rewritten.error.code, -32602);
  const alternative = await (await call(tool, "tools/call", { name: "run_shell", arguments: {} })).json() as any;
  assert.equal(alternative.error.code, -32602);
  assert.equal((await call(tool, "tools/call", { name: "x".repeat(17000) })).status, 413);
  assert.equal(calls, 0);
});

test("MCP failure is sanitized and never retried; closing removes turn endpoint", async () => {
  let calls = 0;
  const tool = new ControlMcp({ chatId: "c", messageId: "m", text: "x" }, {
    forwardMessage: async () => { calls++; throw new Error("secret-token stderr"); },
  });
  await tool.start();
  for (let index = 0; index < 2; index++) {
    const response = await (await call(tool, "tools/call", { name: "control_current_request" })).text();
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
  const tool = new ControlMcp({ chatId: "c", messageId: "m", text: "打开控制台" }, {
    forwardMessage: async () => ({ text }),
  });
  await tool.start();
  t.after(() => tool.close());
  const response = await (await call(tool, "tools/call", { name: "control_current_request" })).text();
  assert.doesNotMatch(response, /one.time-secret/);
  assert.match(response, /#login=\[REDACTED\]/);
  assert.equal(tool.result?.text, text);
  assert.equal(tool.wasCalled, true);
});

test("official MCP client negotiates protocol and invokes the stateless turn tool", async t => {
  const tool = new ControlMcp({ chatId: "c", messageId: "m", text: "查状态" }, {
    forwardMessage: async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
      return { text: "running" };
    },
  });
  await tool.start();
  t.after(() => tool.close());
  const client = new Client({ name: "integration-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(tool.url), {
    requestInit: { headers: { Authorization: `Bearer ${tool.token}` } },
  }));
  try {
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 1);
    const result = await client.callTool({ name: listed.tools[0].name, arguments: {} });
    assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify({ text: "running" }) }]);
  } finally { await client.close(); }
});

test("shutdown errors cannot finish cleanup while a submitted Controller command is still active", async t => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let submitted!: () => void;
  const entered = new Promise<void>(resolve => { submitted = resolve; });
  const tool = new ControlMcp({ chatId: "c", messageId: "m", text: "执行当前任务" }, {
    forwardMessage: async () => { submitted(); await blocked; return { text: "terminal" }; },
  });
  await tool.start();
  const request = call(tool, "tools/call", { name: "control_current_request" })
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
