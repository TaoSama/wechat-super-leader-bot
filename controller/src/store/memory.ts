import { CommandRecord, MessageRecord, ScopedSession, Session, validateCommandSendRoute } from "../types.js";
import { IStore, CreateCommandResult, ConflictError } from "./interface.js";
import { sameSkillRefs } from "../skills.js";
import { nextCommandState, inspectionLimit } from "./command-state.js";
import { executionListQuery } from "./execution-list.js";
import { createTerminalNotification, readNotification, claimNotificationRecord, receiptNotificationRecord,
  NotificationIdSchema, NotificationReceiptStatusSchema, validateNotificationTime, NOTIFICATION_BATCH_LIMIT,
  type Notification, type StoredNotification, type NotificationReceiptStatus } from "../notifications.js";
import { normalizeExecution, validateExecutionUpdate, executionPageLimit, EXECUTION_PAGE_SIZE,
  type CreateExecutionResult, type ExecutionRecord } from "../leader/execution.js";
import { assertExecutionConfirmation, normalizeExecutionConfirmation,
  type ExecutionConfirmationAuthority } from "../leader/execution-confirmation.js";
import {
  LeaderState,
  cloneLeaderState,
  serializeAndValidateLeaderData,
  validateChatId,
  validateExpectedRevision,
} from "../leader/state.js";
import {
  ConsoleLinkRecord,
  ConsoleSessionRecord,
  cloneConsoleLinkRecord,
  cloneConsoleSessionRecord,
  normalizeConsoleLinkRecord,
  normalizeConsoleSessionRecord,
  validateConsoleTokenHash,
  validateIsoTimestamp,
} from "../console/types.js";

export class MemoryStore implements IStore {
  private commands = new Map<string, CommandRecord>();
  private commandsByRequestId = new Map<string, string>(); // requestId -> commandId
  private messages = new Map<string, MessageRecord>(); // JSON.stringify([chatId, messageId]) -> record
  private nodeSessions = new Map<string, Session[]>(); // nodeId -> Session[]
  private leaderStates = new Map<string, LeaderState>(); // chatId -> LeaderState
  private executions = new Map<string, ExecutionRecord>();
  private notifications = new Map<string, StoredNotification>();
  private consoleLinks = new Map<string, ConsoleLinkRecord>(); // tokenHash -> ConsoleLinkRecord
  private consoleSessions = new Map<string, ConsoleSessionRecord>(); // tokenHash -> ConsoleSessionRecord

  async init(): Promise<void> {}
  async close(): Promise<void> {}

  async createCommandIfAbsent(cmd: CommandRecord): Promise<CreateCommandResult> {
    validateCommandSendRoute(cmd);
    if (cmd.requestId && this.commandsByRequestId.has(cmd.requestId)) {
      const existingId = this.commandsByRequestId.get(cmd.requestId)!;
      const existing = this.commands.get(existingId)!;

      // Check payload consistency
      if (
        existing.nodeId !== cmd.nodeId ||
        existing.sessionId !== cmd.sessionId ||
        existing.action !== cmd.action ||
        (existing.prompt || "") !== (cmd.prompt || "") || !sameSkillRefs(existing.skills, cmd.skills)
      ) {
        throw new ConflictError(
          `requestId '${cmd.requestId}' was already used with different payload`
        );
      }

      return { created: false, command: structuredClone(existing) };
    }

    if (this.commands.has(cmd.commandId)) {
      const existing = this.commands.get(cmd.commandId)!;
      return { created: false, command: structuredClone(existing) };
    }

    this.commands.set(cmd.commandId, structuredClone(cmd));
    if (cmd.requestId) {
      this.commandsByRequestId.set(cmd.requestId, cmd.commandId);
    }

    return { created: true, command: structuredClone(cmd) };
  }

  async getCommand(commandId: string): Promise<CommandRecord | null> {
    const cmd = this.commands.get(commandId);
    return cmd ? structuredClone(cmd) : null;
  }

  async findCommandByRequestId(requestId: string): Promise<CommandRecord | null> {
    const commandId = this.commandsByRequestId.get(requestId);
    if (!commandId) return null;
    return this.getCommand(commandId);
  }

  async updateCommandStatus(
    commandId: string,
    status: CommandRecord["status"],
    output?: string,
    error?: string,
    turnId?: string
  ): Promise<void> {
    const cmd = this.commands.get(commandId);
    if (!cmd) return;

    this.commands.set(commandId, nextCommandState(cmd, status, output, error, turnId));
  }

  async markNodeActiveCommandsUncertain(nodeId: string, reason: string): Promise<void> {
    const now = new Date().toISOString();
    for (const cmd of this.commands.values()) {
      if (cmd.nodeId === nodeId && (cmd.status === "pending" || cmd.status === "accepted")) {
        cmd.status = "uncertain";
        cmd.error = reason;
        cmd.updatedAt = now;
      }
    }
  }

  async markExpiredActiveCommandsUncertain(): Promise<void> {
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    for (const cmd of this.commands.values()) {
      if (cmd.status === "pending" || (cmd.status === "accepted" && !cmd.turnId)) {
        const expMs = new Date(cmd.expiresAt).getTime();
        if (expMs <= nowMs) {
          cmd.status = "uncertain";
          cmd.error = "Command expired without terminal result from daemon";
          cmd.updatedAt = nowIso;
        }
      }
    }
  }

  async listRecentCommands(limit = 50): Promise<CommandRecord[]> {
    const list = Array.from(this.commands.values());
    list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return structuredClone(list.slice(0, limit));
  }

  async listInspectableCommands(nodeId: string, limit = 50, afterCommandId = ""): Promise<CommandRecord[]> {
    const count = inspectionLimit(limit);
    return structuredClone([...this.commands.values()].filter(cmd => cmd.nodeId === nodeId && cmd.action === "send" &&
      cmd.turnId && ["accepted", "uncertain"].includes(cmd.status) && cmd.commandId > afterCommandId)
      .sort((a, b) => a.commandId < b.commandId ? -1 : a.commandId > b.commandId ? 1 : 0).slice(0, count));
  }

  async recordMessage(msg: MessageRecord): Promise<void> {
    const key = JSON.stringify([msg.chatId, msg.messageId]);
    if (!this.messages.has(key)) {
      this.messages.set(key, { ...msg });
    }
  }

  async getMessage(chatId: string, messageId: string): Promise<MessageRecord | null> {
    const key = JSON.stringify([chatId, messageId]);
    const rec = this.messages.get(key);
    return rec ? { ...rec } : null;
  }

  async upsertNodeSessions(nodeId: string, sessions: Session[]): Promise<void> {
    this.nodeSessions.set(nodeId, sessions.map((s) => ({ ...s })));
  }

  async getNodeSessions(nodeId: string): Promise<ScopedSession[]> {
    const list = this.nodeSessions.get(nodeId) || [];
    return list.map((s) => ({ ...s, nodeId }));
  }

  async getAllSessions(): Promise<ScopedSession[]> {
    const all: ScopedSession[] = [];
    for (const [nodeId, sessions] of this.nodeSessions.entries()) {
      for (const s of sessions) {
        all.push({ ...s, nodeId });
      }
    }
    return all;
  }

  async removeNodeSessions(nodeId: string): Promise<void> {
    this.nodeSessions.delete(nodeId);
  }

  async getLeaderState(chatId: string): Promise<LeaderState | null> {
    validateChatId(chatId);
    const existing = this.leaderStates.get(chatId);
    if (!existing) return null;
    return cloneLeaderState(existing);
  }

  async compareAndSetLeaderState(
    chatId: string,
    expectedRevision: number,
    data: Record<string, unknown>
  ): Promise<LeaderState | null> {
    validateChatId(chatId);
    validateExpectedRevision(expectedRevision);
    const { clonedData } = serializeAndValidateLeaderData(data);
    const now = new Date().toISOString();

    const existing = this.leaderStates.get(chatId);
    if (!existing) {
      if (expectedRevision !== 0) {
        return null;
      }
      const created: LeaderState = {
        chatId,
        revision: 1,
        data: clonedData,
        updatedAt: now,
      };
      this.leaderStates.set(chatId, created);
      return cloneLeaderState(created);
    }

    if (existing.revision !== expectedRevision) {
      return null;
    }

    const updated: LeaderState = {
      chatId,
      revision: existing.revision + 1,
      data: clonedData,
      updatedAt: now,
    };
    this.leaderStates.set(chatId, updated);
    return cloneLeaderState(updated);
  }

  async confirmExecution(record: ExecutionRecord, authority: ExecutionConfirmationAuthority, now = Date.now): Promise<CreateExecutionResult> {
    const input = normalizeExecutionConfirmation(record, authority);
    // No await between ownership validation and publication of the execution.
    assertExecutionConfirmation(input.record, input.authority, this.leaderStates.get(input.record.chatId) ?? null, now());
    return this.createExecutionRecord(input.record);
  }

  async createExecutionIfAbsent(record: ExecutionRecord): Promise<CreateExecutionResult> {
    const normalized = structuredClone(normalizeExecution(record));
    if (normalized.revision !== 1 || normalized.status !== "active" || normalized.attempts.some(attempt => attempt !== null)) {
      throw new Error("New executions must be active, unclaimed revision one records");
    }
    return this.createExecutionRecord(normalized);
  }

  private createExecutionRecord(normalized: ExecutionRecord): CreateExecutionResult {
    const existing = this.executions.get(normalized.id);
    if (existing) {
      if (existing.chatId !== normalized.chatId || JSON.stringify(existing.plan) !== JSON.stringify(normalized.plan)) {
        throw new ConflictError("Execution ID already used with different chat or plan");
      }
      return { created: false, execution: structuredClone(existing) };
    }
    if ([...this.executions.values()].some(execution => execution.chatId === normalized.chatId && execution.status === "active")) {
      throw new ConflictError("Chat already has an active execution");
    }
    this.executions.set(normalized.id, normalized);
    return { created: true, execution: structuredClone(normalized) };
  }

  async getExecution(id: string): Promise<ExecutionRecord | null> {
    const execution = this.executions.get(id);
    return execution ? structuredClone(execution) : null;
  }

  async getLatestExecution(chatId: string): Promise<ExecutionRecord | null> {
    validateChatId(chatId);
    const candidates = [...this.executions.values()].filter(execution => execution.chatId === chatId)
      .sort((a, b) => Number(b.status === "active") - Number(a.status === "active") ||
        b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    return candidates[0] ? structuredClone(candidates[0]) : null;
  }

  async compareAndSetExecution(next: ExecutionRecord, expectedRevision: number, now = Date.now()): Promise<ExecutionRecord | null> {
    validateNotificationTime(now);
    validateExpectedRevision(expectedRevision);
    const normalized = structuredClone(normalizeExecution(next));
    if (normalized.revision !== expectedRevision + 1) throw new Error("Execution revision must increment by one");
    const current = this.executions.get(normalized.id);
    if (!current || current.revision !== expectedRevision || current.status !== "active") return null;
    validateExecutionUpdate(current, normalized);
    const notification = createTerminalNotification(normalized, now);
    if (notification && this.notifications.has(notification.id)) throw new ConflictError("Execution notification already exists");
    this.executions.set(normalized.id, normalized);
    if (notification) this.notifications.set(notification.id, notification);
    return structuredClone(normalized);
  }

  async listActiveExecutions(limit = EXECUTION_PAGE_SIZE, afterId = ""): Promise<ExecutionRecord[]> {
    const count = executionPageLimit(limit);
    return structuredClone([...this.executions.values()].filter(execution => execution.status === "active" && execution.id > afterId)
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).slice(0, count));
  }

  async listRecentExecutions(chatIds: readonly string[], limit: number): Promise<ExecutionRecord[]> {
    const query = executionListQuery(chatIds, limit);
    const allowed = new Set(query.chatIds);
    return [...this.executions.values()].filter(execution => allowed.has(execution.chatId))
      .sort((a, b) => Number(b.status === "active") - Number(a.status === "active") ||
        b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      .slice(0, query.count).map(execution => structuredClone(normalizeExecution(execution)));
  }

  async listPendingNotifications(chatIds: readonly string[], now: number): Promise<Notification[]> {
    validateNotificationTime(now);
    const query = executionListQuery(chatIds, NOTIFICATION_BATCH_LIMIT);
    return [...this.notifications.values()].filter(item => query.chatIds.includes(item.chatId) && item.status === "pending" && item.expiresAt > now)
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, NOTIFICATION_BATCH_LIMIT).map(item => readNotification(item, now));
  }

  async getNotification(id: string, now: number): Promise<Notification | null> {
    NotificationIdSchema.parse(id);
    validateNotificationTime(now);
    const item = this.notifications.get(id);
    return item ? readNotification(item, now) : null;
  }

  async claimNotification(id: string, attemptId: string, chatIds: readonly string[], now: number): Promise<Notification | null> {
    NotificationIdSchema.parse(id);
    NotificationIdSchema.parse(attemptId);
    validateNotificationTime(now);
    const query = executionListQuery(chatIds, NOTIFICATION_BATCH_LIMIT);
    const current = this.notifications.get(id);
    if (!current) return null;
    const next = claimNotificationRecord(current, attemptId, query.chatIds, now);
    this.notifications.set(id, next);
    return readNotification(next, now);
  }

  async recordNotificationReceipt(id: string, attemptId: string, status: NotificationReceiptStatus, now: number): Promise<Notification | null> {
    NotificationIdSchema.parse(id);
    NotificationIdSchema.parse(attemptId);
    NotificationReceiptStatusSchema.parse(status);
    validateNotificationTime(now);
    const current = this.notifications.get(id);
    if (!current) return null;
    const next = receiptNotificationRecord(current, attemptId, status, now);
    this.notifications.set(id, next);
    return readNotification(next, now);
  }

  // Console Auth Store
  async createConsoleLinkIfAbsent(record: ConsoleLinkRecord): Promise<ConsoleLinkRecord> {
    const normalized = normalizeConsoleLinkRecord(record);
    const existing = this.consoleLinks.get(normalized.tokenHash);
    if (existing) {
      return cloneConsoleLinkRecord(existing);
    }
    const stored = cloneConsoleLinkRecord(normalized);
    this.consoleLinks.set(normalized.tokenHash, stored);
    return cloneConsoleLinkRecord(stored);
  }

  async consumeConsoleLink(
    tokenHash: string,
    session: ConsoleSessionRecord,
    now: string
  ): Promise<boolean> {
    const validTokenHash = validateConsoleTokenHash(tokenHash);
    const normalizedSession = normalizeConsoleSessionRecord(session);
    const validNow = validateIsoTimestamp(now, "now");
    if (validTokenHash === normalizedSession.tokenHash) {
      throw new Error("Session tokenHash must be distinct from one-time link tokenHash");
    }
    if (Date.parse(normalizedSession.expiresAt) <= validNow.ms) {
      throw new Error("Invalid ConsoleSessionRecord: session expiresAt must be greater than now");
    }

    const existingLink = this.consoleLinks.get(validTokenHash);
    if (!existingLink) {
      return false;
    }
    if (existingLink.consumedAt !== undefined) {
      return false;
    }
    if (Date.parse(existingLink.expiresAt) <= validNow.ms) {
      return false;
    }

    existingLink.consumedAt = validNow.iso;
    this.consoleSessions.set(
      normalizedSession.tokenHash,
      cloneConsoleSessionRecord(normalizedSession)
    );
    return true;
  }

  async getConsoleSession(tokenHash: string, now: string): Promise<ConsoleSessionRecord | null> {
    const validTokenHash = validateConsoleTokenHash(tokenHash);
    const validNow = validateIsoTimestamp(now, "now");
    const existing = this.consoleSessions.get(validTokenHash);
    if (!existing) {
      return null;
    }
    if (Date.parse(existing.expiresAt) <= validNow.ms) {
      return null;
    }
    return cloneConsoleSessionRecord(existing);
  }

  async deleteConsoleSession(tokenHash: string): Promise<void> {
    const validTokenHash = validateConsoleTokenHash(tokenHash);
    this.consoleSessions.delete(validTokenHash);
  }
}
