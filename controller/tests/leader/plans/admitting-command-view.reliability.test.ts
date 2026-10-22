import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isPlanCommandAuthorized } from "../../../src/commands/plan-authorization.js";
import { createExecution, executionRequestId, EXECUTION_CLAIM_MS } from "../../../src/leader/plans/execution.js";
import { readExecutionView } from "../../../src/leader/plans/view.js";
import type { CommandRecord } from "../../../src/types.js";

function fixture() {
  const now = Date.now();
  const execution = createExecution("synthetic-chat", { id: randomUUID(), expiresAt: now + 60_000,
    actions: [{ nodeId: "synthetic-node", sessionId: "synthetic-session", prompt: "Synthetic task",
      sendRoute: "control-socket", dependsOn: [] }] }, now);
  execution.attempts[0] = { token: randomUUID(), startedAt: now, expiresAt: now + EXECUTION_CLAIM_MS };
  const action = execution.plan.actions[0];
  const command: CommandRecord = { ...action, action: "send", commandId: "synthetic-command", status: "admitting",
    requestId: executionRequestId(execution, 0), createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString() };
  const store = { findCommandByRequestId: async () => command, getExecution: async () => execution };
  return { now, execution, command, store };
}

describe("plan admitting command views", () => {
  it.each([false, true])("exposes claimed without leaking preparation for metadataOnly=%s", async metadataOnly => {
    const f = fixture();
    const view = await readExecutionView(f.store, f.execution, f.now, metadataOnly);
    expect(view.steps[0]).toMatchObject({ status: "claimed", commandId: f.command.commandId });
    expect(JSON.stringify(view)).not.toContain("admitting");
    expect(f.command.status).toBe("admitting");
  });

  it("keeps the preparation's valid plan authorization available to the dispatch guard", async () => {
    const f = fixture();
    await expect(isPlanCommandAuthorized(f.store, f.command,
      { type: "plan", id: f.execution.id, chatId: f.execution.chatId })).resolves.toBe(true);
  });

  it("does not hide an inconsistent preparation behind claimed", async () => {
    const f = fixture();
    f.command.sessionId = "foreign-session";
    expect((await readExecutionView(f.store, f.execution, f.now)).steps[0].status).toBe("uncertain");
  });
});
