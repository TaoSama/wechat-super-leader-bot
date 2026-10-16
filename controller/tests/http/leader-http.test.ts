import { afterEach, describe, expect, it, vi } from "vitest";
import { ControllerServer } from "../../src/http/server.js";
import { MemoryStore } from "../../src/store/memory.js";
import type { LeaderModel } from "../../src/leader/model/contracts.js";

describe("Leader HTTP boundary", () => {
  let server: ControllerServer | undefined;
  afterEach(async () => { if (server) await server.stop(); });

  it("checks allowlist before model/state access and persists HTTP dedupe", async () => {
    const store = new MemoryStore();
    const stateRead = vi.spyOn(store, "getLeaderState");
    const model: LeaderModel = { complete: vi.fn(async () => ({ content: "没有派发任务", toolCalls: [] })) };
    server = new ControllerServer({ host: "127.0.0.1", port: 0, controllerToken: "test-controller",
      nodeTokens: {}, tokenToNode: new Map(), allowedChatIds: new Set(["allowed"]),
      persistenceMode: "memory", commandTtlSeconds: 60 }, store, model);
    await server.start();
    const address = server.getHttpServer().address();
    if (!address || typeof address === "string") throw new Error("Missing test port");
    const post = (chatId: string, text = "看看进度") => fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
      method: "POST", headers: { authorization: "Bearer test-controller", "content-type": "application/json" },
      body: JSON.stringify({ chatId, messageId: "same-id", text }),
    });
    expect((await post("denied")).status).toBe(403);
    expect(model.complete).not.toHaveBeenCalled();
    expect(stateRead).not.toHaveBeenCalled();
    const first = await post("allowed");
    expect(first.status).toBe(200);
    const expected = await first.json();
    expect(await (await post("allowed")).json()).toEqual(expected);
    expect(model.complete).toHaveBeenCalledTimes(1);
    expect((await post("allowed", "替换请求")).status).toBe(409);
    expect(model.complete).toHaveBeenCalledTimes(1);
  });
});
