import type { IStore } from "../../store/interface.js";
import { TurnIdSchema } from "../../types.js";
import { executionRequestId, matchesExecutionCommand, type ExecutionRecord } from "./execution.js";
import { ExecutionResultSourceSchema, normalizeExecutionInput, recordedOutput, renderExecutionInput, wellFormedText, type ExecutionInput,
  type ExecutionResultSource } from "./input.js";

export class ExecutionInputError extends Error {
  constructor() { super("Execution result source is unavailable or inconsistent"); }
}

function memoizeStep<T>(read: (index: number) => Promise<T>): (index: number) => Promise<T> {
  const pending = new Map<number, Promise<T>>();
  return index => {
    if (!pending.has(index)) pending.set(index, read(index));
    return pending.get(index)!;
  };
}

/** Keep receipts and provenance proofs within this one read of an immutable execution snapshot. */
export function createExecutionInputReader(store: Pick<IStore, "findCommandByRequestId">, execution: ExecutionRecord) {
  const command = memoizeStep(index => store.findCommandByRequestId(executionRequestId(execution, index)));
  const source = memoizeStep<ExecutionResultSource>(async index => {
    const record = await command(index);
    if (!record || !matchesExecutionCommand(execution, index, record) || record.status !== "completed" ||
        record.inputReceipt !== undefined || record.sendRoute === "terminal-pane" || record.sessionId.startsWith("terminal:") ||
        !TurnIdSchema.safeParse(record.turnId).success || typeof record.output !== "string" || !wellFormedText(record.output)) throw new ExecutionInputError();
    if ((execution.plan.actions[index].resultFrom ?? []).length && !await verify(index)) throw new ExecutionInputError();
    const parsed = ExecutionResultSourceSchema.safeParse({ step: index + 1, commandId: record.commandId, turnId: record.turnId!, ...recordedOutput(record.output) });
    if (!parsed.success) throw new ExecutionInputError();
    return parsed.data;
  });

  async function collect(index: number): Promise<ExecutionInput | undefined> {
    const action = execution.plan.actions[index];
    const resultFrom = action.resultFrom ?? [];
    if (!resultFrom.length) return undefined;
    const sources: ExecutionResultSource[] = [];
    for (const step of resultFrom) {
      if (step < 1 || step > index || !action.dependsOn.includes(step) || !execution.attempts[step - 1]) throw new ExecutionInputError();
      sources.push(await source(step - 1));
    }
    return normalizeExecutionInput(action.prompt, resultFrom, { prompt: renderExecutionInput(action.prompt, sources), sources });
  }

  const verify = memoizeStep<boolean>(async index => {
    const frozen = execution.attempts[index]?.input;
    if (!(execution.plan.actions[index].resultFrom ?? []).length) return frozen === undefined;
    if (!frozen) return false;
    try {
      const sampled = await collect(index);
      const action = execution.plan.actions[index];
      return JSON.stringify(sampled) === JSON.stringify(normalizeExecutionInput(action.prompt, action.resultFrom ?? [], frozen));
    } catch (error) {
      if (error instanceof ExecutionInputError) return false;
      throw error;
    }
  });

  const verifyMetadata = memoizeStep<boolean>(async index => {
    const action = execution.plan.actions[index];
    const resultFrom = action.resultFrom ?? [];
    const frozen = execution.attempts[index]?.input;
    if (!resultFrom.length) return frozen === undefined;
    if (!frozen) return false;
    const normalized = normalizeExecutionInput(action.prompt, resultFrom, frozen);
    for (const item of normalized.sources) {
      const parentIndex = item.step - 1;
      if (parentIndex < 0 || parentIndex >= index || !action.dependsOn.includes(item.step) || !execution.attempts[parentIndex]) return false;
      const record = await command(parentIndex);
      if (!record || !matchesExecutionCommand(execution, parentIndex, record) || record.status !== "completed" ||
          record.commandId !== item.commandId || record.turnId !== item.turnId || record.inputReceipt !== undefined ||
          "hasOutput" in record && record.hasOutput !== true ||
          record.sendRoute === "terminal-pane" || !TurnIdSchema.safeParse(record.turnId).success ||
          !await verifyMetadata(parentIndex)) return false;
    }
    return true;
  });

  return { command, collect, verify, verifyMetadata };
}

export function collectExecutionInput(store: Pick<IStore, "findCommandByRequestId">, execution: ExecutionRecord, index: number): Promise<ExecutionInput | undefined> {
  return createExecutionInputReader(store, execution).collect(index);
}

export function verifyExecutionInput(store: Pick<IStore, "findCommandByRequestId">, execution: ExecutionRecord, index: number): Promise<boolean> {
  return createExecutionInputReader(store, execution).verify(index);
}

/** Public status checks frozen provenance against exact immutable receipts without reading bodies. */
export function verifyExecutionInputMetadata(store: Pick<IStore, "findCommandByRequestId">,
  execution: ExecutionRecord, index: number): Promise<boolean> {
  return createExecutionInputReader(store, execution).verifyMetadata(index);
}
