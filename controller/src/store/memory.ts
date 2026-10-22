import { CommandRecord, CommandAuthority, MessageRecord, ScopedSession, Session, SendRoute, validateCommandSendRoute } from "../types.js";
import { ACTIVE_COMMAND_STATUSES, beforeInQueue, sameAuthority, sameCommandPayload } from "../commands/queue.js";
import { InputReceipt } from "../sessions/input-receipt.js";
import { commandSummary, type CommandSummary } from "../commands/public.js";
import { IStore, CreateCommandResult, ConflictError } from "./interface.js";
import { MemoryMessageImages, type StoredMessageImage } from "../sessions/message-images.js";
import { sameSkillRefs } from "../skills/catalog.js";
import { nextCommandState, inspectionLimit, validateStoredCommandInput } from "./command-state.js";
import { validateNodeSessionInventory } from "./node-sessions.js";
import { executionListQuery } from "./execution-list.js";
import { TERMINAL_RESULT_TTL_MS, PROGRESS_RESULT_TTL_MS, RESULT_COLLECTOR_BATCH_SIZE } from "../notifications/result-collector.js";
import { normalizeGoal, assertGoalConfirmation, validateGoalUpdate, goalIsOpen, type GoalRecord,
  type GoalConfirmationAuthority, type CreateGoalResult } from "../leader/goals/goal.js";
import { validateGoalProofs } from "../leader/goals/view.js";
import { notificationCommands, planNotificationRequestIds, goalNotificationRequestIds } from "../notifications/presentation.js";
import { notificationSource, sameNotificationSource, createProgressNotification, progressNotificationEligible, progressNotificationBudgetAvailable, progressNotificationContext, type ProgressContext, type ProgressDraft } from "../notifications/progress.js";
import {NotificationSourceSchema, type NotificationSource } from "../notifications/contracts.js";
import { normalizeNotification, createTerminalNotifications, createGoalNotifications, terminalNotificationPartEligible, readNotification, claimNotificationRecord, receiptNotificationRecord,
  deferNotificationRecord, NotificationDeferReasonSchema, NotificationIdSchema, NotificationReceiptStatusSchema, validateNotificationTime, NOTIFICATION_BATCH_LIMIT,
  type Notification, type StoredNotification, type NotificationReceiptStatus, type NotificationDeferReason } from "../notifications/contracts.js";
import { normalizeExecution, validateExecutionUpdate, executionPageLimit, EXECUTION_PAGE_SIZE,
  type CreateExecutionResult, type ExecutionRecord } from "../leader/plans/execution.js";
import { assertExecutionConfirmation, normalizeExecutionConfirmation,
  type ExecutionConfirmationAuthority } from "../leader/plans/confirmation.js";
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

const KNOWN_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const KNOWN_SESSION_LIMIT = 4096;

export class MemoryStore implements IStore {
  private messageImages = new MemoryMessageImages();
  recordMessageImages(chatId: string, messageId: string, images: StoredMessageImage[], expiresAt: number) {
    return this.messageImages.recordMessageImages(chatId, messageId, images, expiresAt);
  }
  getMessageImage(chatId: string, messageId: string, imageId: string, now: number) {
    return this.messageImages.getMessageImage(chatId, messageId, imageId, now);
  }
  private commands = new Map<string, CommandRecord>();
  private commandsByRequestId = new Map<string, string>(); // requestId -> commandId
  private messages = new Map<string, MessageRecord>(); // JSON.stringify([chatId, messageId]) -> record
  private nodeSessions = new Map<string, Session[]>(); // nodeId -> Session[]
  private knownSessions = new Map<string, {session:Session; observedAt:number}>();
  private queueOrder = 0;
  private leaderStates = new Map<string, LeaderState>(); // chatId -> LeaderState
  private executions = new Map<string, ExecutionRecord>();
  private goals = new Map<string, GoalRecord>();
  private notifications = new Map<string, StoredNotification>();
  private notificationResults = new Map<string, string>();
  private consoleLinks = new Map<string, ConsoleLinkRecord>(); // tokenHash -> ConsoleLinkRecord
  private consoleSessions = new Map<string, ConsoleSessionRecord>(); // tokenHash -> ConsoleSessionRecord

  async init(): Promise<void> {
    for (const command of this.commands.values()) {
      if (command.status !== "preparing") continue;
      command.status = "failed";
      command.error = "Controller restarted before dispatch authorization completed";
      command.updatedAt = new Date().toISOString();
    }
  }
  async close(): Promise<void> {}

  async createCommandIfAbsent(cmd: CommandRecord): Promise<CreateCommandResult> {
    validateCommandSendRoute(cmd);
    validateStoredCommandInput(cmd);
    if (cmd.requestId && this.commandsByRequestId.has(cmd.requestId)) {
      const existingId = this.commandsByRequestId.get(cmd.requestId)!;
      const existing = this.commands.get(existingId)!;

      // Check payload consistency
      if (!sameCommandPayload(existing, cmd) || !sameAuthority(existing.authority, cmd.authority)) {
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

    cmd = { ...cmd, queueOrder: ++this.queueOrder };
    this.commands.set(cmd.commandId, structuredClone(cmd));
    if (cmd.requestId) {
      this.commandsByRequestId.set(cmd.requestId, cmd.commandId);
    }

    return { created: true, command: structuredClone(cmd) };
  }

  async getCommand(commandId: string): Promise<CommandRecord | null> {
    const cmd = this.commands.get(commandId);
    if (cmd) validateStoredCommandInput(cmd);
    return cmd ? structuredClone(cmd) : null;
  }

  async findCommandByRequestId(requestId: string): Promise<CommandRecord | null> {
    const commandId = this.commandsByRequestId.get(requestId);
    if (!commandId) return null;
    return this.getCommand(commandId);
  }

  async findCommandMetadataByRequestId(requestId: string): Promise<CommandSummary | null> {
    const id = this.commandsByRequestId.get(requestId);
    const command = id ? this.commands.get(id) : undefined;
    if (!command) return null;
    validateStoredCommandInput(command);
    return structuredClone(commandSummary(command));
  }

  async updateCommandStatus(
    commandId: string,
    status: CommandRecord["status"],
    output?: string,
    error?: string,
    turnId?: string,
    inputReceipt?: InputReceipt
  ): Promise<void> {
    const cmd = this.commands.get(commandId);
    if (!cmd) return;

    this.commands.set(commandId, nextCommandState(cmd, status, output, error, turnId, inputReceipt));
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
      if (["preparing", "queued"].includes(cmd.status) && Date.parse(cmd.expiresAt) <= nowMs) {
        cmd.status = "expired"; cmd.updatedAt = nowIso;
      }
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

  async listQueuedCommands(limit = 64, afterCommandId = ""): Promise<CommandRecord[]> {
    inspectionLimit(limit);
    const all = [...this.commands.values()];
    return structuredClone(all.filter(cmd => cmd.status === "queued" && cmd.commandId > afterCommandId &&
      (cmd.deliveryMode === "steer" || !all.some(other => other.commandId !== cmd.commandId && other.action === "send" && other.nodeId === cmd.nodeId && other.sessionId === cmd.sessionId &&
        (ACTIVE_COMMAND_STATUSES.includes(other.status) || ["preparing", "queued"].includes(other.status) && beforeInQueue(other, cmd))))
      )
      .sort((a,b) => a.commandId.localeCompare(b.commandId)).slice(0,limit));
  }
  async publishPreparedCommand(commandId: string): Promise<CommandRecord | null> {
    const cmd = this.commands.get(commandId);
    if (!cmd || cmd.status !== "preparing" || Date.parse(cmd.expiresAt) <= Date.now()) return null;
    const next = { ...cmd, status: "queued" as const, updatedAt: new Date().toISOString() };
    this.commands.set(commandId, next);
    return structuredClone(next);
  }
  async claimQueuedCommand(commandId: string, route: SendRoute): Promise<CommandRecord | null> {
    const cmd = this.commands.get(commandId);
    if (!cmd || cmd.status !== "queued" || Date.parse(cmd.expiresAt) <= Date.now()) return null;
    if (cmd.deliveryMode !== "steer" && [...this.commands.values()].some(other => other.commandId !== cmd.commandId && other.action === "send" &&
      other.nodeId === cmd.nodeId && other.sessionId === cmd.sessionId &&
      (ACTIVE_COMMAND_STATUSES.includes(other.status) || ["preparing", "queued"].includes(other.status) && beforeInQueue(other,cmd)))) return null;
    const next = { ...cmd, status: "pending" as const, sendRoute: route, updatedAt: new Date().toISOString() };
    this.commands.set(commandId,next); return structuredClone(next);
  }
  async requeueClaimedCommand(commandId: string): Promise<CommandRecord | null> {
    const cmd = this.commands.get(commandId);
    if (!cmd || cmd.status !== "pending" || cmd.action !== "send" || !["automation", "plan"].includes(cmd.authority?.type ?? "") ||
        cmd.turnId !== undefined || cmd.inputReceipt !== undefined || Date.parse(cmd.expiresAt) <= Date.now()) return null;
    const next = { ...cmd, status: "queued" as const, updatedAt: new Date().toISOString() };
    this.commands.set(commandId, next);
    return structuredClone(next);
  }
  async cancelQueuedCommand(commandId: string, authority?: CommandAuthority): Promise<CommandRecord | null> {
    const cmd = this.commands.get(commandId);
    if (!cmd || authority && authority.type !== "admin" && !sameAuthority(cmd.authority,authority) || !["queued","cancelled"].includes(cmd.status)) return null;
    const next = { ...cmd, status: "cancelled" as const, updatedAt: new Date().toISOString() };
    this.commands.set(commandId,next); return structuredClone(next);
  }

  async listRecentCommands(limit = 50): Promise<CommandRecord[]> {
    const list = Array.from(this.commands.values());
    list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return list.slice(0, limit).map(cmd => { validateStoredCommandInput(cmd); return structuredClone(cmd); });
  }

  async listRecentCommandSummaries(limit = 50): Promise<CommandSummary[]> {
    inspectionLimit(limit);
    return [...this.commands.values()].sort((a, b) => a.createdAt < b.createdAt ? 1 : -1)
      .slice(0, limit).map(command => {
        validateStoredCommandInput(command);
        return structuredClone(commandSummary(command));
      });
  }

  async listInspectableCommands(nodeId: string, limit = 50, afterCommandId = ""): Promise<CommandRecord[]> {
    const count = inspectionLimit(limit);
    return structuredClone([...this.commands.values()].filter(cmd => cmd.nodeId === nodeId && cmd.action === "send" &&
      cmd.sendRoute !== "terminal-pane" && !cmd.sessionId.startsWith("terminal:") && !cmd.inputReceipt &&
      ["accepted", "uncertain", "pending"].includes(cmd.status) && cmd.commandId > afterCommandId)
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
    validateNodeSessionInventory(sessions);
    this.nodeSessions.set(nodeId, sessions.map((s) => ({ ...s })));
    for (const session of sessions) {
      const key = JSON.stringify([nodeId,session.id]);
      this.knownSessions.delete(key);
      this.knownSessions.set(key,{session:structuredClone(session),observedAt:Date.now()});
    }
    this.pruneKnownSessions();
  }
  async getKnownSession(nodeId: string, sessionId: string): Promise<Session | null> {
    this.pruneKnownSessions();
    return structuredClone(this.knownSessions.get(JSON.stringify([nodeId,sessionId]))?.session ?? null);
  }

  private pruneKnownSessions(): void {
    const pinned = new Set<string>();
    const pin = (nodeId:string,sessionId:string) => pinned.add(JSON.stringify([nodeId,sessionId]));
    for (const command of this.commands.values()) if (["preparing","queued",...ACTIVE_COMMAND_STATUSES].includes(command.status)) pin(command.nodeId,command.sessionId);
    for (const execution of this.executions.values()) if (execution.status === "active") for (const action of execution.plan.actions) pin(action.nodeId,action.sessionId);
    for (const goal of this.goals.values()) if (goalIsOpen(goal)) for (const target of goal.proposal.targets) pin(target.nodeId,target.sessionId);
    const threshold = Date.now()-KNOWN_SESSION_TTL_MS;
    for (const [key,entry] of this.knownSessions) if (!pinned.has(key) && (entry.observedAt<threshold || this.knownSessions.size>KNOWN_SESSION_LIMIT)) this.knownSessions.delete(key);
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
    if ([...this.goals.values()].some(goal => goal.chatId === normalized.chatId && goalIsOpen(goal)) ||
      [...this.executions.values()].some(execution => execution.chatId === normalized.chatId && execution.status === "active")) {
      throw new ConflictError("Chat already has an active execution");
    }
    this.executions.set(normalized.id, normalized);
    return { created: true, execution: structuredClone(normalized) };
  }

  async getExecution(id: string): Promise<ExecutionRecord | null> {
    const execution = this.executions.get(id);
    return execution ? structuredClone(normalizeExecution(execution)) : null;
  }

  async getLatestExecution(chatId: string): Promise<ExecutionRecord | null> {
    validateChatId(chatId);
    const candidates = [...this.executions.values()].filter(execution => execution.chatId === chatId)
      .sort((a, b) => Number(b.status === "active") - Number(a.status === "active") ||
        b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    return candidates[0] ? structuredClone(normalizeExecution(candidates[0])) : null;
  }

  async compareAndSetExecution(next: ExecutionRecord, expectedRevision: number, now = Date.now()): Promise<ExecutionRecord | null> {
    validateNotificationTime(now);
    validateExpectedRevision(expectedRevision);
    const normalized = structuredClone(normalizeExecution(next));
    if (normalized.revision !== expectedRevision + 1) throw new Error("Execution revision must increment by one");
    const current = this.executions.get(normalized.id);
    if (!current || current.revision !== expectedRevision || current.status !== "active") return null;
    validateExecutionUpdate(current, normalized);
    const requestIds = ["completed", "failed", "expired"].includes(normalized.status) ? planNotificationRequestIds(normalized) : [];
    const commands = requestIds.length ? await notificationCommands(this, requestIds) : [];
    if (this.executions.get(normalized.id)?.revision !== expectedRevision) return null;
    const notifications = createTerminalNotifications(normalized, now, commands);
    for (const notification of notifications) {
      if (this.notifications.has(notification.id)) throw new ConflictError("Notification ID collision");
    }
    this.executions.set(normalized.id, normalized);
    for (const notification of notifications) this.notifications.set(notification.id,notification);
    return structuredClone(normalized);
  }

  async listActiveExecutions(limit = EXECUTION_PAGE_SIZE, afterId = ""): Promise<ExecutionRecord[]> {
    const count = executionPageLimit(limit);
    return structuredClone([...this.executions.values()].filter(execution => execution.status === "active" && execution.id > afterId)
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).slice(0, count).map(normalizeExecution));
  }

  async listRecentExecutions(chatIds: readonly string[], limit: number): Promise<ExecutionRecord[]> {
    const query = executionListQuery(chatIds, limit);
    const allowed = new Set(query.chatIds);
    return [...this.executions.values()].filter(execution => allowed.has(execution.chatId))
      .sort((a, b) => Number(b.status === "active") - Number(a.status === "active") ||
        b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      .slice(0, query.count).map(execution => structuredClone(normalizeExecution(execution)));
  }

  async confirmGoal(record: GoalRecord, authority: GoalConfirmationAuthority, now = Date.now): Promise<CreateGoalResult> {
    const goal = structuredClone(normalizeGoal(record));
    if (goal.revision !== 1 || goal.status !== "active" || goal.actions.length || goal.decisions.length || goal.decisionAttempts || goal.lease) throw new ConflictError("Goal must be initial");
    assertGoalConfirmation(goal, authority, this.leaderStates.get(goal.chatId) ?? null, now());
    const existing = this.goals.get(goal.id);
    if (existing) {
      if (existing.chatId !== goal.chatId || JSON.stringify(existing.proposal) !== JSON.stringify(goal.proposal)) throw new ConflictError("Goal ID already used");
      return { created: false, goal: structuredClone(existing) };
    }
    if ([...this.goals.values()].some(g => g.chatId === goal.chatId && goalIsOpen(g)) ||
      [...this.executions.values()].some(e => e.chatId === goal.chatId && e.status === "active")) throw new ConflictError("Chat already has an open authorization");
    this.goals.set(goal.id, goal);
    return { created: true, goal: structuredClone(goal) };
  }
  async getGoal(id: string): Promise<GoalRecord | null> {
    const goal = this.goals.get(id); return goal ? structuredClone(normalizeGoal(goal)) : null;
  }
  async getLatestGoal(chatId: string): Promise<GoalRecord | null> {
    validateChatId(chatId);
    return (await this.listRecentGoals([chatId], 1))[0] ?? null;
  }
  async compareAndSetGoal(next: GoalRecord, revision: number, now = Date.now): Promise<GoalRecord | null> {
    validateExpectedRevision(revision);
    const goal = structuredClone(normalizeGoal(next)), current = this.goals.get(goal.id);
    if (!current || current.revision !== revision || !goalIsOpen(current)) return null;
    validateGoalUpdate(current, goal, now());
    await validateGoalProofs(this, current, goal, now());
    if (this.goals.get(goal.id)?.revision !== revision) return null;
    const requestIds = current.status === "active" && ["completed", "blocked", "expired"].includes(goal.status) ? goalNotificationRequestIds(goal) : [];
    const commands = requestIds.length ? await notificationCommands(this, requestIds) : [];
    if (this.goals.get(goal.id)?.revision !== revision) return null;
    const commitTime = now();
    validateGoalUpdate(current, goal, commitTime);
    const notifications = createGoalNotifications(current, goal, commitTime, commands);
    for (const notification of notifications) {
      if (this.notifications.has(notification.id)) throw new ConflictError("Notification ID collision");
    }
    // All validation precedes synchronous publication of all records.
    this.goals.set(goal.id, goal);
    for (const notification of notifications) this.notifications.set(notification.id,notification);
    return structuredClone(goal);
  }
  async listRunnableGoals(limit = 8, afterId = ""): Promise<GoalRecord[]> {
    executionListQuery([], limit);
    return [...this.goals.values()].filter(g => goalIsOpen(g) && g.id > afterId).sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, limit).map(g => structuredClone(normalizeGoal(g)));
  }
  async listRecentGoals(chats: readonly string[], limit: number): Promise<GoalRecord[]> {
    const query = executionListQuery(chats, limit);
    return [...this.goals.values()].filter(g => query.chatIds.includes(g.chatId))
      .sort((a, b) => Number(goalIsOpen(b)) - Number(goalIsOpen(a)) || b.createdAt - a.createdAt || b.id.localeCompare(a.id))
      .slice(0, query.count).map(g => structuredClone(normalizeGoal(g)));
  }

  async listPendingNotifications(chatIds: readonly string[], now: number): Promise<Notification[]> {
    validateNotificationTime(now);
    const query = executionListQuery(chatIds, NOTIFICATION_BATCH_LIMIT);
    const notifications = [...this.notifications.values()];
    return notifications.filter(item => query.chatIds.includes(item.chatId) && item.status === "pending" && item.expiresAt > now &&
      (item.kind !== "progress" || this.progressEligible(item, now)) && terminalNotificationPartEligible(item,notifications))
      .sort((a, b) => Number(a.kind === "progress") - Number(b.kind === "progress") || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, NOTIFICATION_BATCH_LIMIT).map(item => readNotification(item, now));
  }
  async listNotificationCandidates(chatIds: readonly string[], now: number, afterId = "", limit = RESULT_COLLECTOR_BATCH_SIZE): Promise<StoredNotification[]> {
    validateNotificationTime(now);
    if (afterId) NotificationIdSchema.parse(afterId);
    const query = executionListQuery(chatIds, limit);
    const notifications = [...this.notifications.values()];
    return notifications.filter(item => query.chatIds.includes(item.chatId) && item.status === "pending" && !this.notificationResults.has(item.id) && item.id > afterId && item.createdAt <= now &&
      (item.kind !== "progress" ? (item.part?.index ?? 1) === 1 && item.createdAt + TERMINAL_RESULT_TTL_MS > now :
        item.createdAt + PROGRESS_RESULT_TTL_MS > now && item.expiresAt > now && this.progressEligible(item, now) &&
        !notifications.some(other => other.kind === "progress" && other.status === "pending" &&
          sameNotificationSource(other.source, item.source) && other.createdAt <= now &&
          (other.createdAt > item.createdAt || other.createdAt === item.createdAt && other.id > item.id))))
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).slice(0, query.count).map(normalizeNotification);
  }
  async getNotificationParts(source: NotificationSource): Promise<StoredNotification[]> {
    const parsed = NotificationSourceSchema.parse(source);
    return [...this.notifications.values()].filter(item => item.kind !== "progress" && sameNotificationSource(item.source, parsed))
      .sort((a, b) => (a.kind === "progress" ? 0 : a.part?.index ?? 1) - (b.kind === "progress" ? 0 : b.part?.index ?? 1) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(normalizeNotification);
  }
  async markNotificationPrepared(id: string, resultId: string): Promise<void> {
    NotificationIdSchema.parse(id); NotificationIdSchema.parse(resultId);
    const previous = this.notificationResults.get(id);
    if (!this.notifications.has(id) || previous !== undefined && previous !== resultId)
      throw new ConflictError("Notification result marker conflicts with its persisted source");
    this.notificationResults.set(id, resultId);
  }
  private progressEligible(item: StoredNotification, now: number): boolean {
    const record = item.source.type === "plan" ? this.executions.get(item.source.id) : this.goals.get(item.source.id);
    return !!record && progressNotificationEligible(item, record, now);
  }
  async getProgressNotificationContext(source: NotificationSource, now = Date.now()): Promise<ProgressContext | null> {
    NotificationSourceSchema.parse(source); validateNotificationTime(now);
    const record = source.type === "plan" ? this.executions.get(source.id) : this.goals.get(source.id);
    if (!record || !progressNotificationBudgetAvailable(record, [...this.notifications.values()], now)) return null;
    const commands = await notificationCommands(this, "plan" in record ? planNotificationRequestIds(record) : goalNotificationRequestIds(record));
    return progressNotificationContext(record, commands, [...this.notifications.values()], now);
  }
  async enqueueProgressNotification(source: NotificationSource, now = Date.now(), draft?: ProgressDraft): Promise<Notification | null> {
    NotificationSourceSchema.parse(source); validateNotificationTime(now);
    const record = source.type === "plan" ? this.executions.get(source.id) : this.goals.get(source.id);
    if (!record || !sameNotificationSource(notificationSource(record),source)) return null;
    if (!progressNotificationBudgetAvailable(record,[...this.notifications.values()],now)) return null;
    const commands = await notificationCommands(this,"plan" in record ? planNotificationRequestIds(record) : goalNotificationRequestIds(record));
    const latest = source.type === "plan" ? this.executions.get(source.id) : this.goals.get(source.id);
    if (!latest || latest.revision !== record.revision || latest.status !== record.status) return null;
    const notification = createProgressNotification(latest,commands,[...this.notifications.values()],now,draft);
    if (!notification) return null;
    this.notifications.set(notification.id,notification); return readNotification(notification,now);
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
    if (current.kind === "progress" && !this.progressEligible(current,now)) throw new ConflictError("Progress notification source is no longer active");
    if (!terminalNotificationPartEligible(current,[...this.notifications.values()])) throw new ConflictError("Previous notification part is not accepted");
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

  async deferNotification(id: string, attemptId: string, reason: NotificationDeferReason, now: number): Promise<Notification | null> {
    NotificationIdSchema.parse(id);
    NotificationIdSchema.parse(attemptId);
    NotificationDeferReasonSchema.parse(reason);
    validateNotificationTime(now);
    const current = this.notifications.get(id);
    if (!current) return null;
    const next = deferNotificationRecord(current, attemptId, reason, now);
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
