import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGoal, goalRequestId, GOAL_SEND_CLAIM_MS } from "../../../src/leader/goals/goal.js";
import { readGoalView } from "../../../src/leader/goals/view.js";
import type { CommandRecord } from "../../../src/types.js";
import { commit, fixture as schedulerFixture, lease, nextDecision, proposal, schedulers } from "../../fixtures/goals.js";

function fixture() {
  const now = Date.now();
  const goal = commit(lease(createGoal("synthetic-chat", proposal(now), now)), nextDecision());
  const action = goal.actions[0], target = goal.proposal.targets[action.target - 1];
  action.attempt = { token: randomUUID(), startedAt: now, expiresAt: now + GOAL_SEND_CLAIM_MS };
  const command: CommandRecord = { ...target, action: "send", prompt: action.input.prompt,
    commandId: "synthetic-command", status: "preparing", requestId: goalRequestId(goal, 0),
    createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString() };
  return { now, goal, command, store: { findCommandByRequestId: async () => command } };
}

afterEach(async () => {
  await Promise.all(schedulers.splice(0).map(scheduler => scheduler.stop()));
  vi.restoreAllMocks();
});

describe("goal preparing command views", () => {
  it.each([false, true])("exposes claimed without leaking preparation for metadataOnly=%s", async metadataOnly => {
    const f = fixture();
    const view = await readGoalView(f.store, f.goal, f.now, metadataOnly);
    expect(view.actions[0]).toMatchObject({ status: "claimed", commandId: f.command.commandId });
    expect(JSON.stringify(view)).not.toContain("preparing");
    expect(f.command.status).toBe("preparing");
  });

  it("keeps a real scheduler's preparation guard valid and transmits once", async () => {
    const f = await schedulerFixture();
    const create = f.store.createCommandIfAbsent.bind(f.store);
    const observed: string[] = [];
    vi.spyOn(f.store, "createCommandIfAbsent").mockImplementation(async command => {
      const saved = await create(command);
      expect(saved.command.status).toBe("preparing");
      const current = await f.current();
      observed.push((await readGoalView(f.store, current, f.now())).actions[0].status);
      return saved;
    });
    await f.scheduler.advance(f.goal.id);
    await f.scheduler.advance(f.goal.id);
    expect(observed).toEqual(["claimed"]);
    expect((await f.command(0)).status).toBe("accepted");
    expect(f.errors).not.toHaveBeenCalled();
    expect(f.sendCommand).toHaveBeenCalledTimes(1);
  });

  it("does not hide an inconsistent preparation behind claimed", async () => {
    const f = fixture();
    f.command.sessionId = "foreign-session";
    expect((await readGoalView(f.store, f.goal, f.now)).actions[0].status).toBe("uncertain");
  });
});
