import { z } from "zod";

/** Only explicit single-request decisions are representable; session-wide or policy approvals are not. */
export const ApprovalDecisionSchema = z.enum(["accept", "decline"]);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;
export const MAX_APPROVAL_REQUEST_ID_BYTES = 128;
export const MAX_PENDING_APPROVALS = 4;
const MAX_APPROVAL_TEXT_CHARS = 1200;
export const ApprovalRequestIdSchema = z.string().min(1).max(MAX_APPROVAL_REQUEST_ID_BYTES).regex(/^[A-Za-z0-9_.:-]+$/);

const text = z.string().max(MAX_APPROVAL_TEXT_CHARS).optional();
/** Read-only daemon telemetry about one native approval request; never authority to answer it. */
export const PendingApprovalSchema = z.object({
  requestId: ApprovalRequestIdSchema,
  kind: z.enum(["commandExecution", "fileChange", "permissions", "userInput", "other"]),
  turnId: z.string().min(1).max(128).optional(),
  itemId: z.string().max(256).optional(),
  command: text, cwd: text, reason: text, grantRoot: text,
  startedAt: z.string().datetime({ offset: true }).optional(),
  answerable: z.boolean(),
}).strict();
export type PendingApproval = z.infer<typeof PendingApprovalSchema>;
/** Malformed telemetry is dropped instead of rejecting the whole session observation. */
export const PendingApprovalsSchema = z.array(PendingApprovalSchema).max(MAX_PENDING_APPROVALS).optional().catch(undefined);
