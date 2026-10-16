import { z } from "zod";

export const TerminalSessionIdSchema = z.string().regex(/^terminal:[A-Za-z0-9_-]{43}$/);
const uuidV4 = /^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-4[a-fA-F0-9]{3}-[89abAB][a-fA-F0-9]{3}-[a-fA-F0-9]{12}$/;
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const InputReceiptSchema = z.object({
  kind: z.literal("terminal-input-written"),
  sessionId: TerminalSessionIdSchema,
  requestId: z.string().regex(uuidV4),
  promptSHA256: z.string().regex(/^[a-f0-9]{64}$/),
  responseRevision: revision,
  observedRevision: revision,
}).strict().refine(value => value.observedRevision >= value.responseRevision, "Input receipt revision regressed");
export type InputReceipt = z.infer<typeof InputReceiptSchema>;

export function sameInputReceipt(left: InputReceipt, right: InputReceipt): boolean {
  return left.kind === right.kind && left.sessionId === right.sessionId && left.requestId === right.requestId &&
    left.promptSHA256 === right.promptSHA256 && left.responseRevision === right.responseRevision &&
    left.observedRevision === right.observedRevision;
}
