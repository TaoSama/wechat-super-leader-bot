import { CommandRecord, isValidTurnId, validateCommandSendRoute } from "../types.js";
import { InputReceiptSchema, sameInputReceipt, type InputReceipt } from "../input-receipt.js";
import { ConflictError } from "./interface.js";

/** Shared by receipt validation and the store's atomic mutation boundary. */
export function validateCommandTurnBinding(cmd: CommandRecord, status: CommandRecord["status"], turnId?: string,
  inputReceipt?: InputReceipt, output?: string, error?: string): void {
  validateCommandSendRoute(cmd);
  if (cmd.action === "send" && cmd.sendRoute === "terminal-pane") {
    if (!["pending", "input-written", "failed", "uncertain"].includes(status) || turnId !== undefined || cmd.turnId !== undefined || output) {
      throw new ConflictError("Terminal input cannot bind a native turn or task result");
    }
    if (cmd.status === "input-written" && status !== "input-written") throw new ConflictError("Input-written cannot be downgraded or completed");
    if (status === "input-written") {
      const proof = InputReceiptSchema.safeParse(inputReceipt);
      if (!proof.success || proof.data.sessionId !== cmd.sessionId || error !== undefined || cmd.status === "failed" ||
          cmd.inputReceipt && !sameInputReceipt(cmd.inputReceipt, proof.data)) {
        throw new ConflictError("Terminal input receipt does not match the frozen command proof");
      }
    } else if (inputReceipt !== undefined || cmd.inputReceipt !== undefined) {
      throw new ConflictError("Only input-written can carry an input receipt");
    }
    return;
  }
  if (status === "input-written" || inputReceipt !== undefined || cmd.inputReceipt !== undefined) {
    throw new ConflictError("Read and native commands cannot carry terminal input receipts");
  }
  if (cmd.action === "read") {
    if (status === "accepted" || turnId !== undefined) {
      throw new ConflictError("Read command cannot accept or bind a turn");
    }
    return;
  }
  if ((status === "accepted" || status === "completed") && !isValidTurnId(turnId)) {
    throw new ConflictError("Send receipt requires a valid turn ID");
  }
  if (turnId !== undefined && (!isValidTurnId(turnId) ||
      (cmd.turnId !== undefined && cmd.turnId !== turnId) ||
      (cmd.turnId === undefined && (status !== "accepted" || cmd.status === "completed" || cmd.status === "failed")))) {
    throw new ConflictError("Result does not match command turn binding");
  }
  if (cmd.turnId !== undefined && (!isValidTurnId(cmd.turnId) ||
      (status === "failed" && turnId !== cmd.turnId))) {
    throw new ConflictError("Bound command requires matching turn ID");
  }
}

/** Called under the store's atomic update boundary (PG row lock / synchronous memory mutation). */
export function nextCommandState(cmd: CommandRecord, status: CommandRecord["status"], output?: string, error?: string,
  turnId?: string, inputReceipt?: InputReceipt): CommandRecord {
  validateStoredCommandInput(cmd);
  validateCommandTurnBinding(cmd, status, turnId, inputReceipt, output, error);
  if (cmd.status === "completed" || cmd.status === "failed" || cmd.status === "input-written") return cmd;
  return { ...cmd, status, turnId: turnId ?? cmd.turnId,
    ...(inputReceipt ? { inputReceipt: structuredClone(inputReceipt) } : {}),
    // An acceptance snapshot is not the completed turn's recorded result.
    output: status === "completed" ? output : output ?? cmd.output,
    error: error ?? (status === "uncertain" || status === "pending" ? cmd.error : undefined),
    updatedAt: new Date().toISOString() };
}

/** Reject malformed persisted proof before it can be displayed, ACKed or inspected. */
export function validateStoredCommandInput(cmd: CommandRecord): void {
  if (cmd.sendRoute === "terminal-pane" || cmd.status === "input-written" || cmd.inputReceipt !== undefined) {
    validateCommandTurnBinding(cmd, cmd.status, cmd.turnId, cmd.inputReceipt, cmd.output, cmd.error);
  }
}

export function inspectionLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new Error("Invalid inspection query limit");
  return limit;
}
