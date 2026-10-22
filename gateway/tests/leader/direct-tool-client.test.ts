import assert from "node:assert/strict";
import { test } from "node:test";
import { ControllerToolRejectedError } from "../../src/controller/direct-tools.js";
import { ControllerClient } from "../../src/controller/client.js";

const request = { chatId: "chat", messageId: "message", text: "本轮原文" };
const tool = { name: "list_sessions", description: "查询会话", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } };

test("direct tool client authenticates exact frozen context, parses schemas and never retries uncertain calls", async () => {
  const seen: { url: string; body: unknown }[] = [];
  const client = new ControllerClient({ controllerUrl: "http://127.0.0.1:1", controllerToken: "synthetic-token",
    fetchImpl: async (input, init) => {
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer synthetic-token");
      assert.equal(init?.redirect, "error");
      const url = String(input);
      seen.push({ url, body: JSON.parse(String(init?.body)) });
      if (url.endsWith("/list")) return Response.json({ tools: [tool], instructions: "rules", context: { history: [], memories: {} } });
      throw new Error("synthetic uncertain transport");
    } });
  assert.deepEqual(await client.listTools(request), { tools: [tool], instructions: "rules", context: { history: [], memories: {} } });
  const invocation = { ...request, callId: "stable-call", name: tool.name, arguments: {} };
  await assert.rejects(client.callTool(invocation), /synthetic uncertain transport/);
  assert.deepEqual(seen.map(item => item.body), [request, invocation]);
  assert.equal(seen.length, 2);
});

test("direct tool client rejects duplicate tools and malformed result or sideband attachments", async () => {
  let response: unknown = { tools: [tool, tool], instructions: "rules", context: { history: [], memories: {} } };
  const client = new ControllerClient({ controllerUrl: "http://127.0.0.1:1", controllerToken: "synthetic-token",
    fetchImpl: async () => Response.json(response) });
  await assert.rejects(client.listTools(request), /invalid response schema/);
  const invocation = { ...request, callId: "stable-call", name: tool.name, arguments: {} };
  response = { reply: { text: "missing result" } };
  await assert.rejects(client.callTool(invocation), /invalid response schema/);
  response = { result: {}, reply: { text: "bad images", images: [{}] } };
  await assert.rejects(client.callTool(invocation), /image attachments/);
  response = { result: { ok: true }, reply: { text: "业务回执", commandId: "cmd-1" } };
  assert.deepEqual(await client.callTool(invocation), response);
});


test("direct tool client trusts only explicit pre-execution rejection markers on business-rejection 4xx responses", async () => {
  let status = 409;
  let body: unknown = { code: "DIRECT_TOOL_REJECTED", execution: "not_started", error: "synthetic-secret" };
  const client = new ControllerClient({ controllerUrl: "http://127.0.0.1:1", controllerToken: "synthetic-token",
    fetchImpl: async () => Response.json(body, { status }) });
  const invocation = { ...request, callId: "stable-call", name: tool.name, arguments: {} };
  await assert.rejects(client.callTool(invocation), error => error instanceof ControllerToolRejectedError &&
    error.httpStatus === 409 && !error.message.includes("synthetic-secret"));
  status = 403;
  await assert.rejects(client.callTool(invocation), error => error instanceof ControllerToolRejectedError);
  body = { code: "CHAT_NOT_ALLOWED", execution: "not_started" };
  await assert.rejects(client.callTool(invocation), error => error instanceof Error && !(error instanceof ControllerToolRejectedError));
  body = { code: "DIRECT_TOOL_REJECTED", execution: "not_started" };
  for (status of [401, 500]) {
    await assert.rejects(client.callTool(invocation), error => error instanceof Error && !(error instanceof ControllerToolRejectedError));
  }
  status = 409;
  for (body of [{ code: "DIRECT_TOOL_REJECTED" }, { execution: "not_started" }, { code: "DIRECT_TOOL_REJECTED", execution: "started" }]) {
    await assert.rejects(client.callTool(invocation), error => error instanceof Error && !(error instanceof ControllerToolRejectedError));
  }
});
