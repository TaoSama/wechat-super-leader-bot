import { it, expect, vi } from "vitest";
import { MemoryStore } from "../../src/store/memory.js";
import { createExecution, executionRequestId, EXECUTION_CLAIM_MS } from "../../src/leader/plans/execution.js";
import { ExecutionScheduler } from "../../src/leader/plans/scheduler.js";

const NOW = 1_700_000_000_000;
const ID = "00000000-0000-4000-8000-000000000001";
const ATTEMPT = "00000000-0000-4000-8000-000000000099";
it("terminal scheduler transitions use their own clock and cancellation creates no notification", async () => {
  for (const kind of ["completed", "failed", "expired", "cancelled"] as const) {
    const store = new MemoryStore();
    const record = createExecution("chat", { id: ID, expiresAt: NOW + 600_000,
      actions: [{ nodeId: "node", sessionId: "session", prompt: "task", dependsOn: [], sendRoute: "control-socket" }] }, NOW);
    await store.createExecutionIfAbsent(record);
    if (kind === "completed") {
      await store.compareAndSetExecution({ ...record, revision: 2,
        attempts: [{ token: ATTEMPT, startedAt: NOW, expiresAt: NOW + EXECUTION_CLAIM_MS }] }, 1, NOW);
      const stamp = new Date(NOW).toISOString();
      await store.createCommandIfAbsent({ commandId: "exact-command", requestId: executionRequestId(record, 0),
        nodeId: "node", sessionId: "session", action: "send", prompt: "task", sendRoute: "control-socket",
        status: "accepted", turnId: "exact-turn", createdAt: stamp, updatedAt: stamp, expiresAt: new Date(NOW + 600_000).toISOString() });
      await store.updateCommandStatus("exact-command", "completed", "private output", undefined, "exact-turn");
    }
    const now = kind === "expired" ? record.expiresAt : NOW + 1;
    const submit = vi.fn();
    const scheduler = new ExecutionScheduler(store, { submit }, { now: () => now, isChatAllowed: () => kind !== "failed" });
    try {
      if (kind === "cancelled") await scheduler.cancel(ID, "chat");
      else await scheduler.advance(ID);
      expect((await store.getExecution(ID))!.status).toBe(kind);
      const notification = await store.getNotification(ID, now);
      if (kind === "cancelled") expect(notification).toBeNull();
      else expect(notification).toMatchObject({ kind, status: "pending", createdAt: now });
      expect(submit).not.toHaveBeenCalled();
    } finally { await scheduler.stop(); }
  }
});
