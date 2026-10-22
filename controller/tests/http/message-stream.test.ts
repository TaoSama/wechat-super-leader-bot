import { afterEach, describe, expect, it, vi } from "vitest";
import { ControllerServer } from "../../src/http/server.js";
import { MemoryStore } from "../../src/store/memory.js";
import type { LeaderModel, ModelMessage, ModelToolCall } from "../../src/leader/model/contracts.js";

const report = (id: number): ModelToolCall => ({ id: `report-${id}`, type: "function",
  function: { name: "report_progress", arguments: JSON.stringify({ text: `已经核实第${id}项` }) } });
const request = { chatId: "allowed", messageId: "same-id", text: "帮我分析一下" };

describe("Controller query progress stream", () => {
  let server: ControllerServer | undefined;
  let store: MemoryStore;
  afterEach(async () => { if (server) await server.stop(); });
  const start = async (model: LeaderModel) => {
    store = new MemoryStore();
    server = new ControllerServer({ host: "127.0.0.1", port: 0, controllerToken: "synthetic",
      nodeTokens: {}, tokenToNode: new Map(), allowedChatIds: new Set(["allowed"]),
      persistenceMode: "memory", commandTtlSeconds: 60 }, store, model);
    await server.start();
    const address = server.getHttpServer().address();
    if (!address || typeof address === "string") throw new Error("No HTTP test address");
    return (remaining: string | undefined, body = request) => fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
      method: "POST", headers: { authorization: "Bearer synthetic", "content-type": "application/json",
        Accept: "application/x-ndjson", ...(remaining === undefined ? {} : { "X-Progress-Remaining": remaining }) },
      body: JSON.stringify(body),
    });
  };

  it("flushes model-authored progress before completion, returns remaining slots, and deduplicates final replies", async () => {
    let unblock!: () => void;
    const blocked = new Promise<void>(resolve => { unblock = resolve; });
    let calls = 0;
    const results: unknown[] = [];
    const post = await start({ complete: async (messages, tools) => {
      calls++;
      expect(tools.some(tool => tool.function.name === "report_progress")).toBe(true);
      if (calls === 1) return { content: null, toolCalls: [report(1)] };
      results.push(...messages.filter(message => message.role === "tool").map(message => JSON.parse(message.content!)));
      await blocked;
      return { content: "完整的分析结果", toolCalls: [] };
    } });
    const response = await post("2");
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    const reader = response.body!.getReader();
    const first = await reader.read();
    const frame = JSON.parse(new TextDecoder().decode(first.value).trim());
    expect(frame).toMatchObject({ type: "progress", text: "已经核实第1项", remaining: 1 });
    expect(typeof frame.id).toBe("string");
    unblock();
    let rest = "";
    while (true) { const chunk = await reader.read(); if (chunk.done) break; rest += new TextDecoder().decode(chunk.value); }
    expect(JSON.parse(rest.trim())).toMatchObject({ type: "reply", reply: { text: "完整的分析结果" } });
    expect(results).toEqual([{ status: "queued", remaining: 1, limit: 3 }]);
    const replay = await (await post("2")).text();
    expect(JSON.parse(replay.trim())).toMatchObject({ type: "reply", reply: { text: "完整的分析结果" } });
    expect(calls).toBe(2);
  });

  it("honors an inherited budget across several model reports without exposing fake delivery claims", async () => {
    let calls = 0;
    let messages: ModelMessage[] = [];
    const post = await start({ complete: async current => {
      messages = current;
      calls++;
      return calls === 1 ? { content: null, toolCalls: [report(1), report(2), report(3), report(4)] }
        : { content: "最终结果", toolCalls: [] };
    } });
    const events = (await (await post("2")).text()).trim().split("\n").map(line => JSON.parse(line));
    expect(events.map(event => event.type)).toEqual(["progress", "progress", "reply"]);
    expect(events.slice(0, 2).map(event => event.remaining)).toEqual([1, 0]);
    const results = messages.filter(message => message.role === "tool").map(message => JSON.parse(message.content!));
    expect(results.map(result => result.remaining)).toEqual([1, 0, 0, 0]);
    expect(results.every(result => result.sent !== true)).toBe(true);
  });

  it("validates stream budget and chat authorization before model work", async () => {
    let calls = 0;
    const post = await start({ complete: async () => { calls++; return { content: "reply", toolCalls: [] }; } });
    for (const budget of [undefined, "-1", "4", "1.5", "01", "x"]) expect((await post(budget)).status).toBe(400);
    expect((await post("3", { ...request, chatId: "denied" })).status).toBe(403);
    expect(calls).toBe(0);
  });

  it("persists a final reply after the progress recipient disconnects without reexecuting the query", async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const post = await start({ complete: async () => {
      calls++;
      if (calls === 1) return { content: null, toolCalls: [report(1)] };
      await blocked;
      return { content: "断线后仍已保存的结果", toolCalls: [] };
    } });
    const response = await post("3");
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    await reader.cancel();
    release();
    await vi.waitFor(async () => {
      expect((await store.getMessage(request.chatId, request.messageId))?.replyText).toBe("断线后仍已保存的结果");
    });
    const replay = JSON.parse((await (await post("3")).text()).trim());
    expect(replay).toMatchObject({ type: "reply", reply: { text: "断线后仍已保存的结果" } });
    expect(calls).toBe(2);
  });

  it("ends a stream with a safe error event if processing fails after a report", async () => {
    let calls = 0;
    const post = await start({ complete: async () => {
      calls++;
      if (calls === 1) return { content: null, toolCalls: [report(1)] };
      throw new Error("private provider detail");
    } });
    const text = await (await post("3")).text();
    expect(text).not.toContain("private provider detail");
    const events = text.trim().split("\n").map(line => JSON.parse(line));
    // Leader may safely turn provider failure into its own final response; either outcome closes the framing.
    expect(["reply", "error"]).toContain(events.at(-1).type);
    expect(events[0].type).toBe("progress");
  });
});
