import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { WebSocket } from "ws";
import { ControllerServer } from "../../src/http/server.js";
import { MemoryStore } from "../../src/store/memory.js";
import { Config } from "../../src/runtime/config.js";

describe("ControllerServer & Hub Integration", () => {
  let server: ControllerServer;
  let store: MemoryStore;
  const port = 9988;
  const controllerToken = "ctrl-token-123";
  const nodeToken = "node-token-macair";

  const config: Config = {
    port,
    host: "127.0.0.1",
    controllerToken,
    nodeTokens: Object.assign(Object.create(null), { macair: nodeToken }),
    tokenToNode: new Map([[nodeToken, "macair"]]),
    allowedChatIds: new Set(["chat-1"]),
    persistenceMode: "memory",
    commandTtlSeconds: 60,
  };

  beforeAll(async () => {
    store = new MemoryStore();
    server = new ControllerServer(config, store);
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  it("handles health check without auth", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("ok");
  });

  it("rejects unauthorized API access with 401 and INVALID_CONTROLLER_TOKEN on bad token", async () => {
    const res1 = await fetch(`http://127.0.0.1:${port}/v1/status`);
    expect(res1.status).toBe(401);

    const res2 = await fetch(`http://127.0.0.1:${port}/v1/status`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res2.status).toBe(403);
    const body2 = await res2.json();
    expect(body2.code).toBe("INVALID_CONTROLLER_TOKEN");
  });

  it("rejects unauthorized chat ID with CHAT_NOT_ALLOWED code", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${controllerToken}`,
      },
      body: JSON.stringify({
        chatId: "forbidden-chat",
        messageId: "m1",
        text: "列出会话",
      }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("CHAT_NOT_ALLOWED");
  });

  it("does not expose database errors in status responses", async () => {
    const failing = vi.spyOn(store, "listRecentCommandSummaries").mockRejectedValueOnce(new Error("private-database-connection-secret"));
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/status`, {
        headers: { Authorization: `Bearer ${controllerToken}` },
      });
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain("private-database-connection-secret");
    } finally {
      failing.mockRestore();
    }
  });

  it("rejects prototype key tokens like toString or constructor", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/daemon`, {
      headers: { Authorization: "Bearer toString" },
    });

    const err = await new Promise<Error>((resolve) => {
      ws.on("error", resolve);
    });
    expect(err.message).toContain("403");
  });

  it("connects daemon via websocket, registers sessions, and cleans up on disconnect", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/daemon`, {
      headers: { Authorization: `Bearer ${nodeToken}` },
    });

    await new Promise((resolve) => ws.on("open", resolve));

    ws.send(
      JSON.stringify({
        type: "hello",
        version: 1,
        nodeId: "macair",
        sessions: [
          {
            id: "s-app",
            provider: "codex-app",
            title: "App Session",
            cwd: "/tmp",
            status: "idle",
            capabilities: ["read", "send"],
            observedAt: new Date().toISOString(),
          },
        ],
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 150));

    // Check status API
    const res = await fetch(`http://127.0.0.1:${port}/v1/status`, {
      headers: { Authorization: `Bearer ${controllerToken}` },
    });
    expect(res.status).toBe(200);
    const statusData = await res.json();
    expect(statusData.nodes.length).toBe(1);
    expect(statusData.nodes[0].nodeId).toBe("macair");
    expect(statusData.sessions.length).toBe(1);
    expect(statusData.sessions[0].id).toBe("s-app");

    // Disconnect and verify stale sessions are removed
    ws.close();
    await new Promise((resolve) => setTimeout(resolve, 150));

    const resAfter = await fetch(`http://127.0.0.1:${port}/v1/status`, {
      headers: { Authorization: `Bearer ${controllerToken}` },
    });
    const statusAfter = await resAfter.json();
    expect(statusAfter.sessions.length).toBe(0);
  });
});
