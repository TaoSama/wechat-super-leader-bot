import type { IStore } from "../store/interface.js";
import { TurnIdSchema } from "../types.js";
import { executionRequestId, matchesExecutionCommand, type ExecutionRecord } from "./execution.js";
import { ExecutionResultSourceSchema, normalizeExecutionInput, recordedOutput, renderExecutionInput, wellFormedText, type ExecutionInput,
  type ExecutionResultSource } from "./execution-input.js";

export class ExecutionInputError extends Error {
  constructor() { super("Execution result source is unavailable or inconsistent"); }
}

export async function collectExecutionInput(store: IStore, execution: ExecutionRecord, index: number): Promise<ExecutionInput | undefined> {
  const action = execution.plan.actions[index];
  const resultFrom = action.resultFrom ?? [];
  if (!resultFrom.length) return undefined;
  const sources: ExecutionResultSource[] = [];
  for (const step of resultFrom) {
    if (step < 1 || step > index || !action.dependsOn.includes(step) || !execution.attempts[step - 1]) throw new ExecutionInputError();
    const command = await store.findCommandByRequestId(executionRequestId(execution, step - 1));
    if (!command || !matchesExecutionCommand(execution, step - 1, command) || command.status !== "completed" ||
        command.inputReceipt !== undefined || command.sendRoute === "terminal-pane" || command.sessionId.startsWith("terminal:") ||
        !TurnIdSchema.safeParse(command.turnId).success || typeof command.output !== "string" || !wellFormedText(command.output)) throw new ExecutionInputError();
    if ((execution.plan.actions[step - 1].resultFrom ?? []).length && !await verifyExecutionInput(store, execution, step - 1)) throw new ExecutionInputError();
    const source = ExecutionResultSourceSchema.safeParse({ step, commandId: command.commandId, turnId: command.turnId!, ...recordedOutput(command.output) });
    if (!source.success) throw new ExecutionInputError();
    sources.push(source.data);
  }
  return normalizeExecutionInput(action.prompt, resultFrom, { prompt: renderExecutionInput(action.prompt, sources), sources });
}

export async function verifyExecutionInput(store: IStore, execution: ExecutionRecord, index: number): Promise<boolean> {
  const frozen = execution.attempts[index]?.input;
  if (!(execution.plan.actions[index].resultFrom ?? []).length) return frozen === undefined;
  if (!frozen) return false;
  try {
    const sampled = await collectExecutionInput(store, execution, index);
    const action = execution.plan.actions[index];
    return JSON.stringify(sampled) === JSON.stringify(normalizeExecutionInput(action.prompt, action.resultFrom ?? [], frozen));
  } catch (error) {
    if (error instanceof ExecutionInputError) return false;
    throw error;
  }
}
