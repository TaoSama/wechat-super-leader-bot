import type { IStore } from "../store/interface.js";
import { TurnIdSchema } from "../types.js";
import { assertNativeExecutionPlan, executionRequestId, matchesExecutionCommand, type ExecutionRecord } from "./execution.js";

export interface ExecutionView {
  id: string;
  chatId: string;
  status: ExecutionRecord["status"];
  createdAt: number;
  expiresAt: number;
  steps: Array<{
    step: number; nodeId: string; sessionId: string; prompt: string; dependsOn: number[];
    status: string; commandId?: string; turnId?: string; output?: string; error?: string;
  }>;
}

export async function readExecutionView(store: IStore, execution: ExecutionRecord, now: number): Promise<ExecutionView> {
  assertNativeExecutionPlan(execution.plan);
  const steps: ExecutionView["steps"] = [];
  for (const [index, action] of execution.plan.actions.entries()) {
    const step = { step: index + 1, nodeId: action.nodeId, sessionId: action.sessionId,
      prompt: action.prompt, dependsOn: [...action.dependsOn] };
    const attempt = execution.attempts[index];
    const command = await store.findCommandByRequestId(executionRequestId(execution, index));
    if (command && (!attempt || !matchesExecutionCommand(execution, index, command))) {
      steps.push({ ...step, status: "uncertain", error: "Execution command identity is inconsistent" });
    } else if (command) {
      const validTurn = TurnIdSchema.safeParse(command.turnId).success;
      const invalidReceipt = command.status === "input-written" || command.inputReceipt !== undefined ||
        command.sendRoute === "terminal-pane" || command.sessionId.startsWith("terminal:") ||
        (command.status === "completed" || command.status === "accepted") && !validTurn;
      steps.push({ ...step, status: invalidReceipt ? "uncertain" : command.status,
        commandId: command.commandId, ...(validTurn ? { turnId: command.turnId } : {}),
        output: command.output, error: invalidReceipt ? "Execution receipt has no valid exact turn" : command.error });
    } else if (attempt) {
      steps.push({ ...step, status: attempt.expiresAt > now ? "claimed" : "uncertain",
        ...(attempt.expiresAt <= now ? { error: "Execution claim expired without a confirmed command" } : {}) });
    } else {
      steps.push({ ...step, status: execution.status === "active" ? "waiting" :
        execution.status === "completed" ? "uncertain" : execution.status,
      ...(execution.status === "completed" ? { error: "Execution has no confirmed exact command" } : {}) });
    }
  }
  return { id: execution.id, chatId: execution.chatId, status: execution.status,
    createdAt: execution.createdAt, expiresAt: execution.expiresAt, steps };
}
