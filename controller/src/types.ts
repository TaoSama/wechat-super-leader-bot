import { z } from "zod";
import { SkillCatalogSchema, SkillRef, SkillRefsSchema } from "./skills.js";
import { sanitizeModelMetadata } from "./model-metadata.js";

export const ActionTypeSchema = z.enum(["read", "send"]);
export type ActionType = z.infer<typeof ActionTypeSchema>;

export const SendRouteSchema = z.enum(["desktop-owner", "control-socket"]);
export type SendRoute = z.infer<typeof SendRouteSchema>;
export const SendAvailabilitySchema = z.object({
  route: z.literal("desktop-owner"),
  state: z.enum(["ready", "blocked", "unavailable"]),
  observedAt: z.string().datetime({ offset: true }),
  validUntil: z.string().datetime({ offset: true }),
  reason: z.enum(["busy", "preflight-rejected", "unavailable", "checking"]).optional(),
}).strict();

// Contract status: Daemon result status must be one of completed, failed, accepted, uncertain
export const DaemonResultStatusSchema = z.enum([
  "accepted",
  "completed",
  "failed",
  "uncertain",
]);
export type DaemonResultStatus = z.infer<typeof DaemonResultStatusSchema>;

export const CommandStatusSchema = z.enum([
  "pending",
  "accepted",
  "completed",
  "failed",
  "uncertain",
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
  capabilities: z.array(ActionTypeSchema).default([]),
  observedAt: z.string(),
  model: z.string().optional(),
  modelProvider: z.string().optional(),
  reasoningEffort: z.string().optional(),
  updatedAt: z.string().datetime({ offset: true }).optional(),
  preview: z.string().optional(),
  loaded: z.boolean().optional(),
  desktopObservation: DesktopObservationSchema.optional(),
  sendAvailability: SendAvailabilitySchema.optional(),
});
export type Session = z.infer<typeof SessionSchema>;

export const HISTORY_DEFAULT_LIMIT = 30;
export const HISTORY_MAX_LIMIT = 50;
export const HISTORY_MAX_CURSOR_LENGTH = 4096;
export const HISTORY_MAX_TEXT_LENGTH = 16000;

export const HistoryItemSchema = z.object({
  id: z.string().min(1),
  turnId: z.string(),
  kind: z.enum(["user", "assistant", "tool", "system"]),
  type: z.string().min(1),
  text: z.string().max(HISTORY_MAX_TEXT_LENGTH),
  title: z.string().optional(),
  status: z.string().optional(),
  timestamp: z.string().datetime({ offset: true }).optional(),
  truncated: z.boolean().optional(),
});
export type HistoryItem = z.infer<typeof HistoryItemSchema>;

export const SessionHistorySchema = z.object({
  session: SessionSchema,
  historyContext: z.string().uuid(),
  source: z.enum(["control-socket", "codex-desktop"]),
  items: z.array(HistoryItemSchema).max(HISTORY_MAX_LIMIT),
  nextCursor: z.string().min(1).max(HISTORY_MAX_CURSOR_LENGTH).nullable(),
  fetchedAt: z.string().datetime({ offset: true }),
  truncated: z.boolean(),
});
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
  output: z.string().default(""),
  error: z.string().optional(),
  turnId: TurnIdSchema.optional(),
}).refine(value => value.status !== "accepted" || value.turnId !== undefined, {
  message: "Accepted receipt requires a turn ID",
  path: ["turnId"],
});
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
  cursor: z.string().min(1).max(HISTORY_MAX_CURSOR_LENGTH).optional(),
  historyContext: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(HISTORY_MAX_LIMIT).default(HISTORY_DEFAULT_LIMIT),
}).strict().refine(value => !value.cursor || !!value.historyContext, "History cursor requires context");
export interface HistoryReadOptions { cursor?: string; limit?: number; historyContext?: string }

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
}).refine(value => value.action !== "read" || value.sendRoute === undefined, "Read commands cannot carry a send route");
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
  }).strict()
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
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export function validateCommandSendRoute(command: Pick<CommandRecord, "action" | "sendRoute">): void {
  if (command.sendRoute === undefined) return; // Historical records remain readable, but are never replayed.
  SendRouteSchema.parse(command.sendRoute);
  if (command.action !== "send") throw new Error("Read commands cannot carry a send route");
}

export interface MessageRecord {
  chatId: string;
  messageId: string;
  text: string;
  replyText: string;
  commandId?: string;
  createdAt: string;
}

export interface NodeStatus {
  nodeId: string;
  connected: boolean;
  lastHeartbeat: string;
  sessionCount: number;
}
