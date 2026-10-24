import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandService } from "../../src/commands/service.js";
import { ControllerServer } from "../../src/http/server.js";
import { MemoryStore } from "../../src/store/memory.js";

describe("rule-mode HTTP send precedence", () => {
  let server: ControllerServer | undefined;

  afterEach(async () => {
    try {
      await server?.stop();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("submits explicit tasks containing listing words and keeps directory queries read-only", async () => {
    const now = new Date().toISOString();
    const submit = vi.spyOn(CommandService.prototype, "submit").mockImplementation(async (request) => ({
      ...request,
      commandId: "test-command",
      status: "queued",
      expiresAt: now,
      createdAt: now,
      updatedAt: now,
    }));
    server = new ControllerServer({
      host: "127.0.0.1", port: 0, controllerToken: "test-controller",
      nodeTokens: {}, tokenToNode: new Map(), allowedChatIds: new Set(["test-chat"]),
      persistenceMode: "memory", commandTtlSeconds: 60,
    }, new MemoryStore());
    vi.spyOn(server.getNodeHub(), "getAllSessions").mockResolvedValue([{
      id: "s1", nodeId: "node-1", provider: "codex-app", title: "Main session",
      cwd: "/test/project", status: "idle", loaded: true,
      capabilities: ["read", "send"], observedAt: now,
    }]);
    await server.start();
    const address = server.getHttpServer().address();
    if (!address || typeof address === "string") throw new Error("Missing test port");
    let messageNumber = 0;
    const post = async (text: string) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
        method: "POST",
        headers: { authorization: "Bearer test-controller", "content-type": "application/json" },
        body: JSON.stringify({ chatId: "test-chat", messageId: `test-${++messageNumber}`, text }),
      });
      expect(response.status).toBe(200);
      return response.json();
    };

    for (const prompt of ["查看主机配置", "列出任务"]) {
      expect(await post(`让 s1 执行：${prompt}`)).toMatchObject({ commandId: "test-command" });
      expect(submit).toHaveBeenLastCalledWith(
        expect.objectContaining({ nodeId: "node-1", sessionId: "s1", action: "send", prompt }),
        4000, undefined, undefined, { type: "chat", chatId: "test-chat" },
      );
    }
    expect(submit).toHaveBeenCalledTimes(2);

    for (const text of ["查看主机", "列出任务", "让 missing 执行：列出任务"]) {
      expect(await post(text)).not.toHaveProperty("commandId");
    }
    expect(submit).toHaveBeenCalledTimes(2);
  });
});
