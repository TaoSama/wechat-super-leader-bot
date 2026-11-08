import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControllerServer } from "../../src/http/server.js";
import { HttpLeaderModel } from "../../src/leader/model/client.js";
import { BACKGROUND_EXECUTOR_AUTHORIZATION_TOOL_NAME } from "../../src/leader/model/background-executor-authorization.js";
import { MemoryStore } from "../../src/store/memory.js";

const CHAT = "executor-fixture-chat";
const TOKEN = "executor-fixture-controller-token";
let server: ControllerServer | undefined;
let root: string | undefined;
afterEach(async () => {
  try { await server?.stop(); }
  finally {
    server = undefined;
    vi.restoreAllMocks();
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  }
});

async function start() {
  root = mkdtempSync(join(tmpdir(), "background-executor-http-"));
  const provider = { model: "synthetic-background-model", baseUrl: "https://fixture.invalid/v1", apiKey: "synthetic-key" };
  server = new ControllerServer({ host: "127.0.0.1", port: 0, controllerToken: TOKEN,
    nodeTokens: {}, tokenToNode: new Map(), allowedChatIds: new Set([CHAT]), persistenceMode: "memory",
    commandTtlSeconds: 60, controllerDataRoot: root,
    background: { ...provider, executorKind: "codex", root: join(root, "workers"), artifactRoot: join(root, "artifacts"),
      codexPath: "unused", timeoutMs: 10_000, maxConcurrent: 1, summaryProvider: provider } }, new MemoryStore());
  await server.start();
  const address = server.getHttpServer().address();
  if (!address || typeof address === "string") throw new Error("HTTP fixture has no address");
  const origin = `http://127.0.0.1:${address.port}`;
  const request = async (route: string, body?: unknown) => {
    const response = await fetch(origin + route, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5_000) });
    return { status: response.status, body: await response.json() };
  };
  const create = (text: string, executor?: "codex" | "claude") => request("/v1/tools/call", {
    chatId: CHAT, messageId: randomUUID(), callId: randomUUID(), text, name: "create_automation",
    arguments: { kind: "background", title: "整理日报", timezone: "Asia/Shanghai",
      timing: { type: "at", at: new Date(Date.now() + 60_000).toISOString() },
      background: { prompt: "整理日报", ...(executor ? { executor } : {}) } },
  });
  return { create, schedules: () => request(`/v1/automations?chatId=${CHAT}`), status: () => request("/v1/status") };
}

describe("background executor authorization HTTP wiring", () => {
  it("keeps ordinary direct tasks model-free and checks explicit Claude via the background provider in rules mode", async () => {
    const complete = vi.spyOn(HttpLeaderModel.prototype, "complete").mockResolvedValue({ content: null,
      toolCalls: [{ id: "executor-choice", type: "function", function: {
        name: BACKGROUND_EXECUTOR_AUTHORIZATION_TOOL_NAME,
        arguments: JSON.stringify({ approved: true, evidence: "用 Claude 整理日报" }),
      } }] });
    const f = await start();
    const ordinary = await f.create("在后台整理日报");
    expect(ordinary.status).toBe(200);
    expect(ordinary.body.result.background.executor).toBeUndefined();
    expect(complete).not.toHaveBeenCalled();
    const explicit = await f.create("用 Claude 整理日报", "claude");
    expect(explicit.status).toBe(200);
    expect(explicit.body.result.background.executor).toBe("claude");
    expect(complete).toHaveBeenCalledOnce();
    const [messages, tools] = complete.mock.calls[0];
    expect(JSON.parse(messages[1].content!)).toMatchObject({ currentUserMessage: "用 Claude 整理日报" });
    expect(tools.map(tool => tool.function.name)).toEqual([BACKGROUND_EXECUTOR_AUTHORIZATION_TOOL_NAME]);
    expect((await f.schedules()).body.items).toHaveLength(2);
    expect((await f.status()).body.automations.map((schedule: { executor: string }) => schedule.executor)).toEqual(["claude", "codex"]);
  });

  it("refuses a Claude tool argument when its evidence is absent from the bound human message", async () => {
    vi.spyOn(HttpLeaderModel.prototype, "complete").mockResolvedValue({ content: null,
      toolCalls: [{ id: "executor-choice", type: "function", function: {
        name: BACKGROUND_EXECUTOR_AUTHORIZATION_TOOL_NAME,
        arguments: JSON.stringify({ approved: true, evidence: "用 Claude 整理日报" }),
      } }] });
    const f = await start();
    const result = await f.create("在后台整理日报", "claude");
    expect(result.status).toBe(200);
    expect(result.body.result).toMatchObject({ code: "BACKGROUND_EXECUTOR_NOT_AUTHORIZED", error: expect.stringContaining("未创建任务") });
    expect((await f.schedules()).body.items).toHaveLength(0);
  });
});
