import type { ProgressContext, ProgressDraft } from "../notifications/progress.js";
import { CommandRecord, CommandAuthority, MessageRecord, ScopedSession, Session, SendRoute } from "../types.js";
import { InputReceipt } from "../sessions/input-receipt.js";
import { LeaderState } from "../leader/state.js";
import type { CreateExecutionResult, ExecutionRecord } from "../leader/plans/execution.js";
import type { ExecutionConfirmationAuthority } from "../leader/plans/confirmation.js";
import type { Notification, StoredNotification, NotificationReceiptStatus, NotificationDeferReason, NotificationSource } from "../notifications/contracts.js";
import type { GoalRecord, GoalConfirmationAuthority, CreateGoalResult } from "../leader/goals/goal.js";
import type { MessageImageStore } from "../sessions/message-images.js";
import type { CommandSummary } from "../commands/public.js";
import {
  ConsoleLinkRecord,
  ConsoleSessionRecord,
  IConsoleAuthStore,
} from "../console/types.js";

export type { LeaderState } from "../leader/state.js";
export type { CreateExecutionResult, ExecutionRecord } from "../leader/plans/execution.js";
export type { ExecutionConfirmationAuthority } from "../leader/plans/confirmation.js";
export type {
  ConsoleLinkRecord,
  ConsoleSessionRecord,
  IConsoleAuthStore,
} from "../console/types.js";

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export interface CreateCommandResult {
  created: boolean;
  command: CommandRecord;
}

export interface IStore extends IConsoleAuthStore, MessageImageStore {
  init(): Promise<void>;
  close(): Promise<void>;

  // Commands
  createCommandIfAbsent(cmd: CommandRecord): Promise<CreateCommandResult>;
  getCommand(commandId: string): Promise<CommandRecord | null>;
  findCommandByRequestId(requestId: string): Promise<CommandRecord | null>;
  findCommandMetadataByRequestId(requestId: string): Promise<CommandSummary | null>;
  updateCommandStatus(
    commandId: string,
    status: CommandRecord["status"],
    output?: string,
    error?: string,
    turnId?: string,
    inputReceipt?: InputReceipt
  ): Promise<void>;
  markNodeActiveCommandsUncertain(nodeId: string, reason: string): Promise<void>;
  markExpiredActiveCommandsUncertain(): Promise<void>;
  listRecentCommands(limit?: number): Promise<CommandRecord[]>;
  listRecentCommandSummaries(limit?: number): Promise<CommandSummary[]>;
  listInspectableCommands(nodeId: string, limit?: number, afterCommandId?: string): Promise<CommandRecord[]>;
  listQueuedCommands(limit?: number, afterQueueOrder?: number): Promise<CommandRecord[]>;
  claimQueuedCommand(commandId: string, route: SendRoute): Promise<CommandRecord | null>;
  /** Only the original submitter may publish this admitting record after its complete admission checks. */
  admitCommand(commandId: string): Promise<CommandRecord | null>;
  /** Fail an admission only while it is still reserved; never overwrite a claimed or sent command. */
  failAdmittingCommand(commandId: string, error: string): Promise<CommandRecord | null>;
  /** Release this worker's automation or plan claim only before calling transport. Never recover a stale or ambiguous send. */
  requeueClaimedCommand(commandId: string): Promise<CommandRecord | null>;
  cancelQueuedCommand(commandId: string, authority?: CommandAuthority): Promise<CommandRecord | null>;

  // Messages
  recordMessage(msg: MessageRecord): Promise<void>;
  getMessage(chatId: string, messageId: string): Promise<MessageRecord | null>;

  // Session Cache
  upsertNodeSessions(nodeId: string, sessions: Session[]): Promise<void>;
  getNodeSessions(nodeId: string): Promise<ScopedSession[]>;
  getAllSessions(): Promise<ScopedSession[]>;
  removeNodeSessions(nodeId: string): Promise<void>;
  getKnownSession(nodeId: string, sessionId: string): Promise<Session | null>;

  // Leader State
  getLeaderState(chatId: string): Promise<LeaderState | null>;
  compareAndSetLeaderState(
    chatId: string,
    expectedRevision: number,
    data: Record<string, unknown>
  ): Promise<LeaderState | null>;

  // Confirmed executions are separate from conversational revision ownership.
  confirmExecution(record: ExecutionRecord, authority: ExecutionConfirmationAuthority, now?: () => number): Promise<CreateExecutionResult>;
  createExecutionIfAbsent(record: ExecutionRecord): Promise<CreateExecutionResult>;
  getExecution(id: string): Promise<ExecutionRecord | null>;
  getLatestExecution(chatId: string): Promise<ExecutionRecord | null>;
  compareAndSetExecution(next: ExecutionRecord, expectedRevision: number, now?: number): Promise<ExecutionRecord | null>;
  listActiveExecutions(limit?: number, afterId?: string): Promise<ExecutionRecord[]>;
  listRecentExecutions(chatIds: readonly string[], limit: number): Promise<ExecutionRecord[]>;

  confirmGoal(record: GoalRecord, authority: GoalConfirmationAuthority, now?: () => number): Promise<CreateGoalResult>;
  getGoal(id: string): Promise<GoalRecord | null>;
  getLatestGoal(chatId: string): Promise<GoalRecord | null>;
  compareAndSetGoal(next: GoalRecord, revision: number, now?: () => number): Promise<GoalRecord | null>;
  listRunnableGoals(limit?: number, afterId?: string): Promise<GoalRecord[]>;
  listRecentGoals(chatIds: readonly string[], limit: number): Promise<GoalRecord[]>;

  listPendingNotifications(chatIds: readonly string[], now: number): Promise<Notification[]>;
  listNotificationCandidates(chatIds: readonly string[], now: number, afterId?: string, limit?: number): Promise<StoredNotification[]>;
  getNotificationParts(source: NotificationSource): Promise<StoredNotification[]>;
  markNotificationPrepared(id: string, resultId: string): Promise<void>;
  getProgressNotificationContext(source: NotificationSource, now?: number): Promise<ProgressContext | null>;
  enqueueProgressNotification(source: NotificationSource, now?: number, draft?: ProgressDraft): Promise<Notification | null>;
  getNotification(id: string, now: number): Promise<Notification | null>;
  claimNotification(id: string, attemptId: string, chatIds: readonly string[], now: number): Promise<Notification | null>;
  recordNotificationReceipt(id: string, attemptId: string, status: NotificationReceiptStatus, now: number): Promise<Notification | null>;
  deferNotification(id: string, attemptId: string, reason: NotificationDeferReason, now: number): Promise<Notification | null>;
}
