import { describe, it, expect } from "vitest";
import { MemoryStore } from "../src/store/memory.js";
import { CommandRecord } from "../src/types.js";
import { ConflictError } from "../src/store/interface.js";

describe("MemoryStore", () => {
  it("creates and dedupes command by requestId", async () => {
    const store = new MemoryStore();
    await store.init();

    const cmd1: CommandRecord = {
      commandId: "cmd_1",
      requestId: "req_1",
      nodeId: "macair",
      sessionId: "s_1",
      action: "read",
      status: "pending",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const res1 = await store.createCommandIfAbsent(cmd1);
    expect(res1.created).toBe(true);
    expect(res1.command.commandId).toBe("cmd_1");

    // Second call with same requestId & same payload
    const res2 = await store.createCommandIfAbsent({
      ...cmd1,
      commandId: "cmd_2", // different commandId attempt
    });
    expect(res2.created).toBe(false);
    expect(res2.command.commandId).toBe("cmd_1");

    // Call with same requestId but different payload -> ConflictError
    await expect(
      store.createCommandIfAbsent({
        ...cmd1,
        commandId: "cmd_3",
        action: "send",
        prompt: "different",
      })
    ).rejects.toThrow(ConflictError);
  });

  it("marks active commands uncertain on node disconnection", async () => {
    const store = new MemoryStore();
    await store.init();

    const cmdPending: CommandRecord = {
      commandId: "cmd_p",
      requestId: "req_p",
      nodeId: "macair",
      sessionId: "s_1",
      action: "send",
      prompt: "hi",
      status: "pending",
      expiresAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const cmdAccepted: CommandRecord = {
      commandId: "cmd_a",
      requestId: "req_a",
      nodeId: "macair",
      sessionId: "s_1",
      action: "send",
      prompt: "hi2",
      status: "accepted",
      turnId: "accepted-turn",
      expiresAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const cmdCompleted: CommandRecord = {
      commandId: "cmd_c",
      requestId: "req_c",
      nodeId: "macair",
      sessionId: "s_1",
      action: "read",
      status: "completed",
      expiresAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await store.createCommandIfAbsent(cmdPending);
    await store.createCommandIfAbsent(cmdAccepted);
    await store.createCommandIfAbsent(cmdCompleted);

    await store.markNodeActiveCommandsUncertain("macair", "Node disconnected");

    const p = await store.getCommand("cmd_p");
    const a = await store.getCommand("cmd_a");
    const c = await store.getCommand("cmd_c");

    expect(p?.status).toBe("uncertain");
    expect(a?.status).toBe("uncertain");
    expect(c?.status).toBe("completed"); // Terminal remains completed
  });
});
