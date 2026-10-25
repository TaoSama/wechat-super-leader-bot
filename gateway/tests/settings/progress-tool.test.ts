import assert from "node:assert/strict";
import { test } from "node:test";
import { ControlMcp } from "../../src/leader/control-mcp.js";
import { DEFAULT_PROGRESS_TOOL, parseProgressTool, validateProgressArguments } from "../../src/settings/progress-tool.js";

function editable() { return structuredClone(DEFAULT_PROGRESS_TOOL); }

test("progress schema edits apply string constraints and produce an immutable snapshot", () => {
  const input = editable();
  input.description = "汇报核实过的进展";
  input.inputSchema.properties.text = { type: "string", minLength: 3, maxLength: 6, pattern: "^已", enum: ["已核实", "已完成"], description: "以已开头" };
  const tool = parseProgressTool(JSON.stringify(input));
  assert.equal(tool.description, input.description);
  assert.equal(validateProgressArguments(tool, { text: "已核实" }), true);
  for (const args of [{ text: "已" }, { text: "已完成所有检查" }, { text: "在核实" }, { text: "已发现" },
    { text: "已核实", other: "value" }, null, [], {}, { text: 1 }]) {
    assert.equal(validateProgressArguments(tool, args), false, JSON.stringify(args));
  }
  assert.equal(Object.isFrozen(tool.inputSchema.properties.text.enum), true);
  assert.equal(Object.isFrozen(tool.inputSchema.properties), true);
  assert.throws(() => { tool.description = "changed"; }, TypeError);
});

test("progress schema rejects unsupported or unsafe contract changes before saving", () => {
  const invalid: ((tool: any) => void)[] = [
    tool => { tool.name = "send_anything"; },
    tool => { tool.description = " "; },
    tool => { tool.inputSchema.additionalProperties = true; },
    tool => { tool.inputSchema.required = []; },
    tool => { tool.inputSchema.required.push("other"); },
    tool => { tool.inputSchema.properties.other = { type: "string" }; },
    tool => { tool.inputSchema.properties.text.type = "number"; },
    tool => { tool.inputSchema.properties.text.maxLength = 2001; },
    tool => { tool.inputSchema.properties.text.minLength = 0; },
    tool => { tool.inputSchema.properties.text.maxLength = 1.5; },
    tool => { tool.inputSchema.properties.text.minLength = 10; tool.inputSchema.properties.text.maxLength = 5; },
    tool => { tool.inputSchema.properties.text.pattern = "["; },
    tool => { tool.inputSchema.properties.text.pattern = 5; },
    tool => { tool.inputSchema.properties.text.description = {}; },
    tool => { tool.inputSchema.properties.text.enum = []; },
    tool => { tool.inputSchema.properties.text.enum = ["valid", "valid"]; },
    tool => { tool.inputSchema.properties.text.enum = [" "]; },
    tool => { tool.inputSchema.properties.text.enum = [2]; },
    tool => { tool.inputSchema.properties.text.enum = ["too long"]; tool.inputSchema.properties.text.maxLength = 3; },
    tool => { tool.inputSchema.oneOf = []; },
    tool => { tool.inputSchema.properties.text.format = "email"; },
    tool => { tool.inputSchema.properties.text.$ref = "https://example.test/schema"; },
    tool => { tool.annotations = {}; },
  ];
  for (const mutate of invalid) {
    const tool = editable(); mutate(tool);
    assert.throws(() => parseProgressTool(JSON.stringify(tool)), Error, mutate.toString());
  }
  assert.throws(() => parseProgressTool("null"));
  assert.throws(() => parseProgressTool("not json"));
  assert.throws(() => parseProgressTool(" ".repeat(16001)));
});

test("missing length constraints are normalized and the delivery hard boundary remains enforced", () => {
  const input = editable();
  delete input.inputSchema.properties.text.minLength;
  delete input.inputSchema.properties.text.maxLength;
  const tool = parseProgressTool(JSON.stringify(input));
  assert.equal(tool.inputSchema.properties.text.minLength, 1);
  assert.equal(tool.inputSchema.properties.text.maxLength, 2000);
  assert.equal(validateProgressArguments(tool, { text: " " }), false);
  assert.equal(validateProgressArguments(tool, { text: "a".repeat(2000) }), true);
  assert.equal(validateProgressArguments(tool, { text: "a".repeat(2001) }), false);
  input.inputSchema.properties.text = { type: "string", minLength: 1, maxLength: 1 };
  assert.equal(validateProgressArguments(parseProgressTool(JSON.stringify(input)), { text: "😀" }), true);
});

test("a costly edited regular expression cannot block progress delivery indefinitely", () => {
  const input = editable();
  input.inputSchema.properties.text.pattern = "^(a+)+$";
  const tool = parseProgressTool(JSON.stringify(input));
  assert.equal(validateProgressArguments(tool, { text: "a".repeat(1000) + "!" }), false);
});

test("literal and complex patterns enforce matching even without an enum", () => {
  for (const pattern of ["^已", "^已[核完](实|成)$"]) {
    const input = editable();
    input.inputSchema.properties.text.pattern = pattern;
    const tool = parseProgressTool(JSON.stringify(input));
    assert.equal(validateProgressArguments(tool, { text: "已核实" }), true);
    assert.equal(validateProgressArguments(tool, { text: "正在核实" }), false);
  }
});

test("MCP advertises and enforces the same frozen edited schema without changing the root query allowance", async t => {
  const schema = editable();
  schema.description = "Custom progress description";
  schema.inputSchema.properties.text = { type: "string", minLength: 3, maxLength: 6, pattern: "^已", enum: ["已核实", "已完成"] };
  const delivered: string[] = [];
  const tool = new ControlMcp({ chatId: "chat", messageId: "root", text: "检查状态" }, {
    listTools: async () => ({ tools: [], instructions: "" }),
    callTool: async () => ({ result: {} }),
  }, { progressTool: schema, progress: async text => { delivered.push(text); return { sent: true }; } });
  schema.description = "Mutated after constructor";
  schema.inputSchema.properties.text.pattern = "^永远不匹配$";
  await tool.start();
  t.after(() => tool.close());
  async function rpc(method: string, params?: unknown) {
    const response = await fetch(tool.url, { method: "POST", headers: { Authorization: `Bearer ${tool.token}`,
      "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }) });
    assert.equal(response.status, 200);
    return await response.json() as any;
  }
  const listing = await rpc("tools/list");
  assert.equal(listing.result.tools[0].description, "Custom progress description");
  assert.equal(listing.result.tools[0].inputSchema.properties.text.pattern, "^已");
  assert.equal(listing.result.tools[0].inputSchema.properties.text.maxLength, 6);
  for (const text of ["已", "已完成所有检查", "在核实", "已发现"]) {
    const rejected = await rpc("tools/call", { name: "report_progress", arguments: { text } });
    assert.equal(rejected.error.code, -32602);
  }
  for (let index = 0; index < 4; index++) {
    const accepted = await rpc("tools/call", { name: "report_progress", arguments: { text: "已核实" } });
    assert.equal(accepted.error, undefined, JSON.stringify(accepted.error));
    assert.equal(JSON.parse(accepted.result.content[0].text).status, index < 3 ? "sent" : "limit_reached");
  }
  assert.deepEqual(delivered, ["已核实", "已核实", "已核实"]);
});
