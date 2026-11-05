import { z } from "zod";
import { SkillCatalogSchema, SkillRef, SkillRefsSchema } from "./skills/catalog.js";
import { sanitizeModelMetadata } from "./sessions/model-metadata.js";
import { InputReceiptSchema, TerminalSessionIdSchema, type InputReceipt } from "./sessions/input-receipt.js";
import { isTerminalHistoryTarget, isTerminalSession } from "./sessions/terminal.js";
import { CLAUDE_SESSION_ID_PATTERN, isClaudeCodeSession, isClaudeSessionId } from "./sessions/claude.js";
import { ApprovalDecisionSchema, ApprovalRequestIdSchema, PendingApprovalsSchema, type ApprovalDecision } from "./sessions/approval-contracts.js";
import { CommandAttachmentsSchema, type AttachmentRef } from "./sessions/inbound-attachments.js";

export const ActionTypeSchema = z.enum(["read", "send", "interrupt", "approve"]);
export type ActionType = z.infer<typeof ActionTypeSchema>;
export const MAX_DAEMON_CONTROL_MESSAGE_BYTES = 1024 * 1024;
export const MAX_TURN_OUTPUT_BYTES = 8 * 1024 * 1024;
export const MAX_DAEMON_RESULT_MESSAGE_BYTES = 6 * MAX_TURN_OUTPUT_BYTES + 64 * 1024;
export const SessionCapabilitySchema = z.enum(["read", "send", "resume-send"]);

export const SendRouteSchema = z.enum(["desktop-owner", "control-socket", "app-server-resume", "terminal-pane", "claude-resume"]);
export type SendRoute = z.infer<typeof SendRouteSchema>;
export const DeliveryModeSchema = z.enum(["next-turn", "steer"]);
export type DeliveryMode = z.infer<typeof DeliveryModeSchema>;
export const SteerGenerationSchema = z.number().int().nonnegative();
export type CommandAuthority =
  | { type: "admin" }
  | { type: "chat"; chatId: string; steerGeneration?: number }
  | { type: "automation"; chatId: string; scheduleId: string; runId: string }
  | { type: "console"; tokenHash: string; expiresAt: string }
  | { type: "plan" | "goal"; id: string; chatId: string };
export const CommandAuthoritySchema = z.union([
  z.object({type:z.literal("admin")}).strict(),
  z.object({type:z.literal("chat"),chatId:z.string().min(1).max(64),steerGeneration:SteerGenerationSchema.optional()}).strict(),
  z.object({type:z.literal("automation"),chatId:z.string().min(1).max(64),scheduleId:z.string().uuid(),runId:z.string().uuid()}).strict(),
  z.object({type:z.literal("console"),tokenHash:z.string().regex(/^[a-f0-9]{64}$/),expiresAt:z.string().datetime({offset:true})}).strict(),
  z.object({type:z.enum(["plan","goal"]),id:z.string().uuid(),chatId:z.string().min(1).max(64)}).strict(),
]);
const SendAvailabilityFields = {
  state: z.enum(["ready", "blocked", "unavailable"]),
  observedAt: z.string().datetime({ offset: true }),
  validUntil: z.string().datetime({ offset: true }),
  reason: z.enum(["busy", "preflight-rejected", "unavailable", "checking"]).optional(),
};
export const SendAvailabilitySchema = z.discriminatedUnion("route", [
  z.object({ route: z.literal("desktop-owner"), ...SendAvailabilityFields }).strict(),
  z.object({ route: z.literal("terminal-pane"), mode: z.literal("non-atomic"), ...SendAvailabilityFields }).strict(),
]);

// Contract status: Daemon result status must be one of completed, failed, accepted, uncertain
export const DaemonResultStatusSchema = z.enum([
  "accepted",
  "completed",
  "failed",
  "uncertain",
  "input-written",
]);
export type DaemonResultStatus = z.infer<typeof DaemonResultStatusSchema>;

export const CommandStatusSchema = z.enum([
  "admitting",
  "queued",
  "cancelled",
  "expired",
  "pending",
  "accepted",
  "completed",
  "failed",
  "uncertain",
  "input-written",
]);
export type CommandStatus = z.infer<typeof CommandStatusSchema>;

export const MAX_TURN_ID_BYTES = 128;
export function isValidTurnId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_TURN_ID_BYTES &&
    !/[\p{White_Space}\p{Cc}\uD800-\uDFFF\uFFFD]/u.test(value);
}
export const TurnIdSchema = z.string().refine(isValidTurnId, "Invalid turn ID");

export const DesktopObservationSchema = z.object({
  status: z.enum(["active", "idle", "unknown"]),
  observedAt: z.string().datetime({ offset: true }).optional(),
  availability: z.enum(["available", "unavailable"]),
  source: z.literal("codex-desktop"),
  model: z.unknown().optional().transform(sanitizeModelMetadata),
  modelProvider: z.unknown().optional().transform(sanitizeModelMetadata),
  reasoningEffort: z.unknown().optional().transform(sanitizeModelMetadata),
}).transform(({ model, modelProvider, reasoningEffort, ...observation }) => ({
  ...observation,
  ...(model === undefined ? {} : { model }),
  ...(modelProvider === undefined ? {} : { modelProvider }),
  ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
}));
export type DesktopObservation = z.infer<typeof DesktopObservationSchema>;

// Session schema:
// capabilities must NOT default to ['read', 'send'], must be required array or default([])
// status must default to 'unknown' (not idle)
export const SessionSchema = z.object({
  id: z.string().min(1),
  provider: z.string().default("codex-app"),
  title: z.string().default(""),
  cwd: z.string().default(""),
  status: z.string().default("unknown"),
  capabilities: z.array(SessionCapabilitySchema).default([]),
  observedAt: z.string(),
  model: z.string().optional(),
  modelProvider: z.string().optional(),
  reasoningEffort: z.string().optional(),
  updatedAt: z.string().datetime({ offset: true }).optional(),
  preview: z.string().optional(),
  loaded: z.boolean().optional(),
  desktopObservation: DesktopObservationSchema.optional(),
  sendAvailability: SendAvailabilitySchema.optional(),
  historySource: z.enum(["terminal-transcript", "wechat-codex"]).optional(),
  pendingApprovals: PendingApprovalsSchema,
}).refine(session => session.historySource !== "terminal-transcript" || isTerminalHistoryTarget(session), "Invalid terminal history target")
  .refine(session => session.historySource !== "wechat-codex" ||
    session.provider === "wechat-codex" && session.capabilities.length === 1 && session.capabilities[0] === "read",
    "Invalid WeChat history target");
export type Session = z.infer<typeof SessionSchema>;

export const HISTORY_DEFAULT_LIMIT = 30;
export const HISTORY_MAX_LIMIT = 50;
export const HISTORY_MAX_CURSOR_LENGTH = 4096;
export const HISTORY_MAX_TEXT_LENGTH = 16000;
export const HISTORY_MAX_TURN_STATUSES = 2048;
export const HISTORY_MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

const HistoryTurnStatusSchema = z.enum(["inProgress", "completed", "failed", "interrupted"]);

export const HistoryItemSchema = z.object({
  id: z.string().min(1),
  turnId: z.string(),
  turnStatus: HistoryTurnStatusSchema.optional(),
  kind: z.enum(["user", "assistant", "tool", "system"]),
  type: z.string().min(1),
  text: z.string().max(HISTORY_MAX_TEXT_LENGTH),
  title: z.string().optional(),
  status: z.string().optional(),
  timestamp: z.string().datetime({ offset: true }).optional(),
  durationMs: z.number().int().nonnegative().max(HISTORY_MAX_DURATION_MS).optional(),
  truncated: z.boolean().optional(),
});
export type HistoryItem = z.infer<typeof HistoryItemSchema>;

export const HistorySourceSchema = z.enum(["control-socket", "codex-desktop", "terminal-transcript", "wechat-codex", "claude-transcript"]);
export const SessionHistorySchema = z.object({
  session: SessionSchema,
  historyContext: z.string().uuid(),
  source: HistorySourceSchema,
  items: z.array(HistoryItemSchema).max(HISTORY_MAX_LIMIT),
  nextCursor: z.string().min(1).max(HISTORY_MAX_CURSOR_LENGTH).nullable(),
  fetchedAt: z.string().datetime({ offset: true }),
  truncated: z.boolean(),
  turnStatuses: z.record(TurnIdSchema, HistoryTurnStatusSchema)
    .refine(value => Object.keys(value).length <= HISTORY_MAX_TURN_STATUSES, "Too many history turn statuses").optional(),
}).refine(history => history.source === "wechat-codex"
  ? history.session.historySource === "wechat-codex" && history.session.provider === "wechat-codex" &&
    history.session.capabilities.length === 1 && history.session.capabilities[0] === "read"
  : history.source === "terminal-transcript"
  ? isTerminalHistoryTarget(history.session) && history.session.historySource === "terminal-transcript" &&
    history.items.every(item => (item.kind === "user" || item.kind === "assistant") &&
      (item.type === "transcript_message" || item.type === "transcript_chunk"))
  : history.source === "claude-transcript"
  ? isClaudeCodeSession(history.session)
  : !isTerminalSession(history.session) && !isClaudeSessionId(history.session.id), "History source does not match session");
export type SessionHistory = z.infer<typeof SessionHistorySchema>;

export interface ScopedSession extends Session {
  nodeId: string;
}

// Wire v1 protocol messages: Daemon -> Controller
export const DaemonHelloMessageSchema = z.object({
  type: z.literal("hello"),
  version: z.literal(1),
  nodeId: z.string().min(1),
  sessions: z.array(SessionSchema),
  skills: SkillCatalogSchema,
  // Missing on legacy v1 nodes; only an explicit steer advertisement grants support.
  deliveryModes: z.array(DeliveryModeSchema).max(DeliveryModeSchema.options.length).optional(),
  // Legacy nodes ignore unknown command fields, so attachments go only to nodes that advertise them.
  inputAttachments: z.boolean().optional(),
});
export type DaemonHelloMessage = z.infer<typeof DaemonHelloMessageSchema>;

export const DaemonHeartbeatMessageSchema = z.object({
  type: z.literal("heartbeat"),
  sessions: z.array(SessionSchema),
  skills: SkillCatalogSchema,
});
export type DaemonHeartbeatMessage = z.infer<typeof DaemonHeartbeatMessageSchema>;

// DaemonResult does not allow 'pending'
export const DaemonResultMessageSchema = z.object({
  type: z.literal("result"),
  commandId: z.string().min(1),
  status: DaemonResultStatusSchema,
  output: z.string().optional(),
  error: z.string().optional(),
  turnId: TurnIdSchema.optional(),
  inputReceipt: InputReceiptSchema.optional(),
}).refine(value => value.status !== "accepted" || value.turnId !== undefined, {
  message: "Accepted receipt requires a turn ID",
  path: ["turnId"],
}).refine(value => value.status === "input-written"
  ? value.inputReceipt !== undefined && value.turnId === undefined &&
    (value.output === undefined || value.output === "") && value.error === undefined
  : value.inputReceipt === undefined, "Input-written requires only a precise input receipt and empty output");
export type DaemonResultMessage = z.infer<typeof DaemonResultMessageSchema>;

export const DaemonHistoryMessageSchema = z.object({
  type: z.literal("history"),
  requestId: z.string().uuid(),
  sessionId: z.string().min(1),
  history: SessionHistorySchema.optional(),
  error: z.string().optional(),
}).refine(value => (value.history !== undefined) !== (value.error !== undefined), {
  message: "history response must contain exactly one of history or error",
});
export type DaemonHistoryMessage = z.infer<typeof DaemonHistoryMessageSchema>;

export const DaemonMessageSchema = z.discriminatedUnion("type", [
  DaemonHelloMessageSchema,
  DaemonHeartbeatMessageSchema,
  DaemonResultMessageSchema,
  DaemonHistoryMessageSchema,
]);
export type DaemonMessage = z.infer<typeof DaemonMessageSchema>;

// Wire v1 protocol messages: Controller -> Daemon
export const HistoryReadOptionsSchema = z.object({
  source: z.literal("control-socket").optional(),
  cursor: z.string().min(1).max(HISTORY_MAX_CURSOR_LENGTH).optional(),
  historyContext: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(HISTORY_MAX_LIMIT).default(HISTORY_DEFAULT_LIMIT),
}).strict().refine(value => !value.cursor || !!value.historyContext, "History cursor requires context");
export interface HistoryReadOptions { cursor?: string; limit?: number; historyContext?: string; source?: "control-socket" | "wechat-codex" }

export const ControllerReadHistoryMessageSchema = z.object({
  type: z.literal("read_history"),
  requestId: z.string().uuid(),
  nodeId: z.string().min(1).max(64),
  sessionId: z.string().min(1).max(64),
  ...HistoryReadOptionsSchema.shape,
}).refine(value => !value.cursor || !!value.historyContext, "History cursor requires context");
export type ControllerReadHistoryMessage = z.infer<typeof ControllerReadHistoryMessageSchema>;

export const ControllerCancelHistoryMessageSchema = z.object({
  type: z.literal("cancel_history"),
  requestId: z.string().uuid(),
  nodeId: z.string().min(1).max(64),
  sessionId: z.string().min(1).max(64),
}).strict();

type ExactTurnShape = { action: ActionType; prompt?: string; skills?: unknown[]; deliveryMode?: DeliveryMode; expectedTurnId?: string; sessionId: string;
  approvalRequestId?: string; approvalDecision?: ApprovalDecision };
/** Interrupt and approve target exactly one native turn and carry no input, skills or delivery mode. */
function isExactTurnShape(value: ExactTurnShape): boolean {
  return value.prompt === undefined && !value.skills?.length && value.deliveryMode === undefined &&
    isValidTurnId(value.expectedTurnId) && !value.sessionId.startsWith("terminal:") && !isClaudeSessionId(value.sessionId) &&
    (value.action === "approve") === (value.approvalRequestId !== undefined && value.approvalDecision !== undefined);
}
function hasValidTurnTarget(value: ExactTurnShape): boolean {
  if (value.action !== "approve" && (value.approvalRequestId !== undefined || value.approvalDecision !== undefined)) return false;
  if (value.action === "interrupt" || value.action === "approve") return isExactTurnShape(value);
  return value.deliveryMode === "steer" ? value.action === "send" && value.expectedTurnId !== undefined : value.expectedTurnId === undefined;
}

export const ControllerCommandMessageSchema = z.object({
  type: z.literal("command"),
  commandId: z.string().min(1),
  nodeId: z.string().min(1),
  sessionId: z.string().min(1),
  action: ActionTypeSchema,
  prompt: z.string().optional(),
  expiresAt: z.string(), // ISO8601
  skills: SkillRefsSchema.optional(),
  sendRoute: SendRouteSchema.optional(),
  deliveryMode: DeliveryModeSchema.optional(),
  expectedTurnId: TurnIdSchema.optional(),
  approvalRequestId: ApprovalRequestIdSchema.optional(),
  approvalDecision: ApprovalDecisionSchema.optional(),
  attachments: CommandAttachmentsSchema.optional(),
}).refine(value => value.action !== "read" || value.sendRoute === undefined, "Read commands cannot carry a send route")
  .refine(value => value.action !== "read" || value.deliveryMode === undefined,"Read commands cannot carry delivery mode")
  .refine(hasValidTurnTarget, "Only steer, interrupt and approve require an exact expected turn ID")
  .refine(value => value.action !== "send" ||
    (value.sendRoute === "terminal-pane" ? TerminalSessionIdSchema.safeParse(value.sessionId).success : !value.sessionId.startsWith("terminal:")),
  "Terminal targets require the exclusive terminal-pane send route")
  .refine(value => value.action !== "send" || isClaudeSessionId(value.sessionId) === (value.sendRoute === "claude-resume") &&
    (value.sendRoute !== "claude-resume" || CLAUDE_SESSION_ID_PATTERN.test(value.sessionId) && value.deliveryMode !== "steer"),
  "Claude Code targets require the exclusive next-turn claude-resume send route");
export type ControllerCommandMessage = z.infer<typeof ControllerCommandMessageSchema>;

export interface InspectTurnMessage {
  type: "inspect_turn";
  commandId: string;
  nodeId: string;
  sessionId: string;
  turnId: string;
}

export interface ResultAckMessage {
  type: "result_ack";
  commandId: string;
  turnId?: string;
  status: DaemonResultStatus;
  inputReceipt?: InputReceipt;
}

// HTTP API schemas:
// PostCommand: requestId is REQUIRED and non-empty.
// If action is "send", prompt must be non-empty after trim.
export const PostCommandRequestSchema = z
  .object({
    nodeId: z.string().min(1).max(64),
    sessionId: z.string().min(1).max(64),
    action: ActionTypeSchema,
    prompt: z.string().max(16000).optional(),
    requestId: z.string().min(1).max(128), // required & non-empty
    skills: SkillRefsSchema.optional(),
    deliveryMode: DeliveryModeSchema.optional(),
    expectedTurnId: TurnIdSchema.optional(),
    approvalRequestId: ApprovalRequestIdSchema.optional(),
    approvalDecision: ApprovalDecisionSchema.optional(),
    attachments: CommandAttachmentsSchema.optional(),
  }).strict()
  .refine(value => value.action === "send" || value.attachments === undefined, "Only send commands carry attachments")
  .refine(value => value.action !== "read" || value.deliveryMode === undefined,"Read commands cannot carry delivery mode")
  .refine(hasValidTurnTarget, "Only steer, interrupt and approve require an exact expected turn ID")
  .refine(
    (data) => {
      if (data.action === "send") {
        return typeof data.prompt === "string" && data.prompt.trim().length > 0;
      }
      return !data.skills?.length;
    },
    {
      message: "prompt must be non-empty when action is 'send'",
      path: ["prompt"],
    }
  );
export type PostCommandRequest = z.infer<typeof PostCommandRequestSchema>;

export const PostMessageRequestSchema = z.object({
  chatId: z.string().min(1).max(64),
  messageId: z.string().min(1).max(128),
  text: z.string().min(1).max(16000),
});
export type PostMessageRequest = z.infer<typeof PostMessageRequestSchema>;

export interface CommandRecord {
  commandId: string;
  requestId: string;
  nodeId: string;
  sessionId: string;
  action: ActionType;
  prompt?: string;
  skills?: SkillRef[];
  sendRoute?: SendRoute;
  status: CommandStatus;
  output?: string;
  error?: string;
  turnId?: string;
  inputReceipt?: InputReceipt;
  deliveryMode?: DeliveryMode;
  expectedTurnId?: string;
  approvalRequestId?: string;
  approvalDecision?: ApprovalDecision;
  authority?: CommandAuthority;
  /** Frozen inbound attachment descriptors; the daemon fetches bytes with node authentication. */
  attachments?: AttachmentRef[];
  queueOrder?: number;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export function validateCommandSendRoute(command: Pick<CommandRecord, "action" | "sendRoute" | "sessionId">): void {
  const terminal = command.sessionId.startsWith("terminal:");
  if (command.action === "send" && terminal && command.sendRoute !== "terminal-pane") throw new Error("Terminal sends require the terminal-pane route");
  if (command.sendRoute === "terminal-pane" && !TerminalSessionIdSchema.safeParse(command.sessionId).success) throw new Error("Terminal route requires a precise terminal session");
  if (command.action === "send" && isClaudeSessionId(command.sessionId) && command.sendRoute !== "claude-resume") throw new Error("Claude Code sends require the claude-resume route");
  if (command.sendRoute === "claude-resume" && !CLAUDE_SESSION_ID_PATTERN.test(command.sessionId)) throw new Error("Claude route requires a precise Claude Code session");
  if (command.sendRoute === undefined) return; // Historical records remain readable, but are never replayed.
  SendRouteSchema.parse(command.sendRoute);
  if ((command.action === "interrupt" || command.action === "approve") && command.sendRoute !== "terminal-pane") return;
  if (command.action !== "send") throw new Error("Read commands cannot carry a send route");
}

export interface MessageRecord {
  chatId: string;
  messageId: string;
  text: string;
  replyText: string;
  commandId?: string;
  images?: import("./sessions/media-contracts.js").ReplyImage[];
  createdAt: string;
}

export interface NodeStatus {
  nodeId: string;
  connected: boolean;
  lastHeartbeat: string;
  sessionCount: number;
}
