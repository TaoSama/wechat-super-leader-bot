import { z } from "zod";
import { LeaderDataSchema } from "./contracts.js";
import { normalizeExecution, type ExecutionRecord } from "./execution.js";
import type { LeaderState } from "./state.js";
import { ConflictError } from "../store/interface.js";

const AuthoritySchema = z.object({
  revision: z.number().int().positive().refine(Number.isSafeInteger),
  messageId: z.string().min(1).max(128),
  inputHash: z.string().min(1).max(128),
}).strict();
export type ExecutionConfirmationAuthority = z.infer<typeof AuthoritySchema>;

export function normalizeExecutionConfirmation(record: ExecutionRecord, authority: ExecutionConfirmationAuthority) {
  try {
    const normalized = normalizeExecution(record);
    const ownership = AuthoritySchema.parse(authority);
    if (normalized.revision !== 1 || normalized.status !== "active" || normalized.attempts.some(attempt => attempt !== null)) {
      throw new ConflictError("Confirmation requires an unclaimed active revision one execution");
    }
    return { record: structuredClone(normalized), authority: ownership };
  } catch (error) {
    if (error instanceof ConflictError) throw error;
    throw new ConflictError("Invalid execution confirmation record or authority");
  }
}

export function assertExecutionConfirmation(record: ExecutionRecord, authority: ExecutionConfirmationAuthority,
  state: Pick<LeaderState, "chatId" | "revision" | "data"> | null, now: number): void {
  const data = LeaderDataSchema.safeParse(state?.data);
  const claim = data.success ? data.data.inflight : undefined;
  if (!state || state.chatId !== record.chatId || state.revision !== authority.revision || !claim ||
      claim.messageId !== authority.messageId || claim.inputHash !== authority.inputHash || !claim.plan ||
      JSON.stringify(claim.plan) !== JSON.stringify(record.plan)) {
    throw new ConflictError("Execution confirmation ownership or frozen plan changed");
  }
  if (!Number.isSafeInteger(now) || now < 0 || record.createdAt > now || record.expiresAt <= now ||
      !Number.isSafeInteger(claim.expiresAt) || claim.expiresAt <= now ||
      !Number.isSafeInteger(claim.plan.expiresAt) || claim.plan.expiresAt <= now) {
    throw new ConflictError("Execution confirmation authority expired or has an invalid timestamp");
  }
}
