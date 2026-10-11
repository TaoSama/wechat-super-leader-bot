import { CommandRecord, isValidTurnId } from "../types.js";
import { ConflictError } from "./interface.js";

/** Shared by receipt validation and the store's atomic mutation boundary. */
export function validateCommandTurnBinding(cmd: CommandRecord, status: CommandRecord["status"], turnId?: string): void {
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
export function nextCommandState(cmd: CommandRecord, status: CommandRecord["status"], output?: string, error?: string, turnId?: string): CommandRecord {
  validateCommandTurnBinding(cmd, status, turnId);
  if (cmd.status === "completed" || cmd.status === "failed") return cmd;
  return { ...cmd, status, turnId: turnId ?? cmd.turnId,
    output: output ?? cmd.output,
    error: error ?? (status === "uncertain" || status === "pending" ? cmd.error : undefined),
    updatedAt: new Date().toISOString() };
}

export function inspectionLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new Error("Invalid inspection query limit");
  return limit;
}
