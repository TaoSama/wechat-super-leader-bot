import { expect, it } from "vitest";
import { CLAIM_TTL_MS, type Plan } from "../../../src/leader/contracts.js";
import { recoverSteerPlanCommand, steerPlanRequestId } from "../../../src/leader/plans/steer.js";
import { MemoryStore } from "../../../src/store/memory.js";
import type { CommandRecord } from "../../../src/types.js";

const CHAT_ID = "steer-recovery-chat";
const PLAN_ID = "steer-recovery-plan";
const ACTIVE_TURN = "steer-recovery-turn";
const mismatches: { description: string; patch: Partial<CommandRecord> }[] = [
  { description: "another chat", patch: { authority: { type: "chat", chatId: "foreign-chat", steerGeneration: 1 } } },
  { description: "admin authority", patch: { authority: { type: "admin" } } },
  { description: "different prompt", patch: { prompt: "unrelated supplement" } },
  { description: "different send route", patch: { sendRoute: "desktop-owner" } },
];

it.each(mismatches)("rejects mismatched durable steer receipts from $description", async ({ patch }) => {
  const store = new MemoryStore();
  const now = Date.now();
  const plan: Plan = { id: PLAN_ID, expiresAt: now + CLAIM_TTL_MS, actions: [{
    nodeId: "node", sessionId: "session", prompt: "original supplement", dependsOn: [],
    deliveryMode: "steer", expectedTurnId: ACTIVE_TURN, sendRoute: "control-socket",
  }] };
  const command: CommandRecord = {
    commandId: "steer-recovery-command", requestId: steerPlanRequestId(CHAT_ID, PLAN_ID),
    nodeId: "node", sessionId: "session", action: "send", prompt: plan.actions[0].prompt,
    deliveryMode: "steer", expectedTurnId: ACTIVE_TURN, sendRoute: "control-socket",
    authority: { type: "chat", chatId: CHAT_ID, steerGeneration: 1 }, status: "accepted", turnId: ACTIVE_TURN,
    createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + CLAIM_TTL_MS).toISOString(), ...patch,
  };
  await store.createCommandIfAbsent(command);
  expect(await recoverSteerPlanCommand(store, CHAT_ID, plan)).toBeNull();
  expect(await store.getLeaderState(CHAT_ID)).toBeNull();
  expect(await store.getCommand(command.commandId)).toMatchObject({ status: "accepted", ...patch });
});
