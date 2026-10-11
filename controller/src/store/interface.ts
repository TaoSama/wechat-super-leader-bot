import { CommandRecord, InputReceipt, MessageRecord, ScopedSession, Session } from "../types.js";
import { LeaderState } from "../leader/state.js";
import type { CreateExecutionResult, ExecutionRecord } from "../leader/execution.js";
import type { ExecutionConfirmationAuthority } from "../leader/execution-confirmation.js";
import type { Notification, NotificationReceiptStatus } from "../notifications.js";
import {
  ConsoleLinkRecord,
  ConsoleSessionRecord,
  IConsoleAuthStore,
} from "../console/types.js";

export type { LeaderState } from "../leader/state.js";
export type { CreateExecutionResult, ExecutionRecord } from "../leader/execution.js";
export type { ExecutionConfirmationAuthority } from "../leader/execution-confirmation.js";
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

export interface IStore extends IConsoleAuthStore {
  init(): Promise<void>;
  close(): Promise<void>;

  // Commands
  createCommandIfAbsent(cmd: CommandRecord): Promise<CreateCommandResult>;
  getCommand(commandId: string): Promise<CommandRecord | null>;
  findCommandByRequestId(requestId: string): Promise<CommandRecord | null>;
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
  listInspectableCommands(nodeId: string, limit?: number, afterCommandId?: string): Promise<CommandRecord[]>;

  // Messages
  recordMessage(msg: MessageRecord): Promise<void>;
  getMessage(chatId: string, messageId: string): Promise<MessageRecord | null>;

  // Session Cache
  upsertNodeSessions(nodeId: string, sessions: Session[]): Promise<void>;
  getNodeSessions(nodeId: string): Promise<ScopedSession[]>;
  getAllSessions(): Promise<ScopedSession[]>;
  removeNodeSessions(nodeId: string): Promise<void>;

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

  listPendingNotifications(chatIds: readonly string[], now: number): Promise<Notification[]>;
  getNotification(id: string, now: number): Promise<Notification | null>;
  claimNotification(id: string, attemptId: string, chatIds: readonly string[], now: number): Promise<Notification | null>;
  recordNotificationReceipt(id: string, attemptId: string, status: NotificationReceiptStatus, now: number): Promise<Notification | null>;
}
