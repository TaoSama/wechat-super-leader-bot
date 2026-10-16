import { createHash, randomUUID } from "node:crypto";
import { CommandError, CommandService } from "../commands/service.js";
import { NodeHub } from "../nodes/hub.js";
import { ConflictError, IStore } from "../store/interface.js";
import type { LeaderModel, ModelMessage, ModelToolCall } from "./model/contracts.js";
import { hasSkillRefs } from "../skills/catalog.js";
import { selectExecutionObservation, selectModelObservation } from "../sessions/observation.js";
import { selectSendRoute } from "../sessions/send-eligibility.js";
import { readinessFailure, waitForSendReadiness, type ReadinessHub } from "../sessions/send-readiness.js";
import { failureReply, modelDiagnostic } from "./model/errors.js";
import { createExecution, hasTerminalTarget, matchesExecutionCommand, validatePlanDependencies } from "./plans/execution.js";
import { assertTerminalSingleStep, submitTerminalPlan, TERMINAL_INPUT_WARNING } from "./plans/terminal.js";
import { ExecutionScheduler } from "./plans/scheduler.js";
import { executionSummary } from "./plans/presentation.js";
import { readSessionHistory } from "./queries/session-history.js";
import { GoalConversation, goalConfirmation, goalCancellation } from "./goals/conversation.js";
import { GoalScheduler } from "./goals/scheduler.js";
import { createGoalDecider } from "./goals/model.js";
import { goalPreview } from "./goals/presentation.js";
import {
  CLAIM_TTL_MS, ConsoleLinkIssued, ConsoleLinkIssuer, LEADER_TOOLS, LeaderData, LeaderDataSchema, LeaderReply, MAX_HISTORY_ITEMS,
  MAX_MODEL_STEPS, MAX_RECEIPTS, MAX_REPLY_CHARS, MAX_RESULT_CODE_POINTS, MAX_RESULT_JSON_CHARS, MAX_TOOL_CALLS, PLAN_TTL_MS, Plan,
  SYSTEM_PROMPT, TURN_TIMEOUT_MS, ToolArguments,
} from "./contracts.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clip = (text: string, length: number) => {
  const value = text.slice(0, length);
  return /[\uD800-\uDBFF]$/.test(value) ? value.slice(0, -1) : value;
};
const confirmation = /^(?:确认执行|按这个计划执行|就按这个执行|确认这个计划)[。！!]?$/;
const cancellation = /^(?:请|帮我)?(?:取消计划|不用执行|取消执行|停止后续任务|停止后续执行|先别跑后面的任务)[。！!]?$/;
type Hub = Pick<NodeHub, "getAllSessions" | "getNodeStatusList" | "getNodeSession" | "isNodeConnected" | "getAllSkills" | "getNodeSkills" | "readHistory"> & ReadinessHub;


const sanitizeConsoleLinkSecrets = (text: string, issuedUrl?: string): string => {
  let result = text;
  if (issuedUrl) {
    result = result.replaceAll(issuedUrl, "[一次性控制台登录链接已生成，有效期1小时]");
  }
  result = result.replace(/#login=[A-Za-z0-9_.~%-]+/g, "#login=[REDACTED]");
  return result;
};

interface LinkContext {
  requestId: string;
  cachedLinkPromise?: Promise<ConsoleLinkIssued>;
  issuedLink?: ConsoleLinkIssued;
}
interface QueryTrace { modelSteps: number; toolCalls: number; lastTool?: string; lastModelMs?: number; totalModelMs: number }

export class LeaderOrchestrator {
  private active = new Map<string, { messageId: string; inputHash: string; promise: Promise<LeaderReply> }>();
  private executions: ExecutionScheduler;
  private goals: GoalConversation;
  constructor(private store: IStore, private hub: Hub, private commands: Pick<CommandService, "submit">,
    private model: LeaderModel, private now: () => number = Date.now, private consoleLinkIssuer?: ConsoleLinkIssuer,
    executions?: ExecutionScheduler, goals?: GoalScheduler) {
    this.executions = executions ?? new ExecutionScheduler(store, commands, { now });
    this.goals = new GoalConversation(store, hub, goals ?? new GoalScheduler(store, commands, createGoalDecider(model), { now }), now);
  }

  handle(chatId: string, messageId: string, text: string): Promise<LeaderReply> {
    const inputHash = hash(text);
    const active = this.active.get(chatId);
    if (active) {
      if (active.messageId === messageId && active.inputHash === inputHash) return active.promise;
      return Promise.reject(new CommandError(409, "该聊天上一条请求仍在处理中，请稍后再试"));
    }
    if (this.active.size >= 64) return Promise.reject(new CommandError(503, "Leader 当前繁忙"));
    const promise = this.run(chatId, messageId, text, inputHash);
    this.active.set(chatId, { messageId, inputHash, promise });
    const release = () => { this.active.delete(chatId); };
    promise.then(release, release);
    return promise;
  }

  private async run(chatId: string, messageId: string, text: string, inputHash: string): Promise<LeaderReply> {
    const saved = await this.store.getLeaderState(chatId);
    const data = LeaderDataSchema.parse(saved?.data ?? {});
    const pendingGoalBefore = data.pendingGoal;
    const receipt = data.receipts.find(item => item.messageId === messageId);
    if (receipt) {
      if (receipt.inputHash !== inputHash) throw new ConflictError("Message ID already used with different text");
      return { text: receipt.text, commandId: receipt.commandId };
    }
    if (data.inflight) {
      if (data.inflight.expiresAt > this.now()) throw new CommandError(409, "上一条请求尚未结束，请稍后查询");
      const prior = data.inflight;
      const recovered = prior.plan ? await this.executions.view(prior.plan.id, chatId) : null;
      for (const step of recovered?.steps ?? []) if (step.commandId) data.commandIds.push(step.commandId);
      const recoveryText = `上次对话处理被中断，未自动重试原指令。${prior.goal ? await this.goals.recovery(chatId, prior.goal.id) : recovered
        ? `已确认计划仍按持久记录核查与推进：\n${executionSummary(recovered)}`
        : "尚无可确认的持久执行记录，不自动创建或派发。请先核查会话状态。"}`;
      data.receipts.push({ messageId: prior.messageId, inputHash: prior.inputHash, text: recoveryText });
      data.inflight = undefined;
      data.pending = undefined;
      if (prior.messageId === messageId) {
        if (prior.inputHash !== inputHash) throw new ConflictError("Message ID already used with different text");
        await this.save(chatId, saved!.revision, data);
        return { text: recoveryText };
      }
    }
    const previousPlan = data.pending;
    const plan = confirmation.test(text.trim()) ? previousPlan : undefined;
    const goalId = goalConfirmation(text.trim());
    const goal = goalId && data.pendingGoal?.id === goalId ? data.pendingGoal : undefined;
    data.pending = undefined;
    if (goal) data.pendingGoal = undefined;
    data.inflight = { messageId, inputHash, expiresAt: this.now() + CLAIM_TTL_MS, plan, goal };
    const claimed = await this.save(chatId, saved?.revision ?? 0, data);
    let reply: LeaderReply;
    const linkContext: LinkContext = {
      requestId: `console_link_${hash([chatId, messageId])}`,
    };
    if (goalCancellation(text.trim())) {
      data.pendingGoal = undefined;
      reply = await this.goals.cancel(chatId);
    } else if (goalId || text.trim().startsWith("确认目标")) {
      reply = goal ? await this.goals.confirm(chatId, claimed.revision, goal, data)
        : { text: "没有该ID的待确认目标；未派发。请先核对目标预览，并回复‘确认目标 <UUID>’。" };
    } else if (cancellation.test(text.trim())) {
      if (await this.goals.hasUnfinished(chatId)) {
        data.pendingGoal = undefined;
        reply = await this.goals.cancel(chatId);
      } else {
        const latest = await this.store.getLatestExecution(chatId);
        const cancelled = latest?.status === "active" ? await this.executions.cancel(latest.id, chatId) : null;
        reply = { text: cancelled ? `已取消待确认计划；以下已确认计划停止后续派发。\n${executionSummary(cancelled)}`
          : "已取消待确认计划；当前没有活动执行计划。没有新增派发，不会停止原会话已有任务。" };
      }
    } else if (confirmation.test(text.trim())) {
      reply = plan ? await this.executePlan(chatId, claimed.revision, plan, data)
        : { text: "当前没有待确认计划。请告诉我希望哪些会话完成什么任务。" };
    } else {
      const memoriesBefore = { ...data.memories };
      const startedAt = Date.now();
      const reference = hash([chatId, messageId]).slice(0, 12);
      const trace: QueryTrace = { modelSteps: 0, toolCalls: 0, totalModelMs: 0 };
      try {
        reply = await this.reason(chatId, text, data, linkContext, trace, previousPlan);
      } catch (error) {
        if (error instanceof ConflictError) throw error;
        console.warn('Leader processing failed; no plan dispatched', {
          requestRef: reference, elapsedMs: Date.now() - startedAt, ...trace, ...modelDiagnostic(error),
        });
        data.memories = memoriesBefore;
        data.pending = undefined;
        data.pendingGoal = pendingGoalBefore;
        reply = { text: failureReply(error, reference) };
      }
    }
    // Confirmation must never authorize steps or skill versions hidden by clipping.
    if ((data.pending || data.pendingGoal && data.pendingGoal !== pendingGoalBefore) && reply.text.length > MAX_REPLY_CHARS) {
      data.pending = undefined;
      data.pendingGoal = undefined;
      reply = { text: this.attachConsoleLink("计划内容过长，无法完整展示供确认，未保存待确认计划，也未派发。请缩短任务内容或分批提出。", linkContext) };
    }
    reply.text = clip(reply.text, MAX_REPLY_CHARS);
    data.inflight = undefined;
    data.receipts.push({ messageId, inputHash, ...reply });
    const userHistory = sanitizeConsoleLinkSecrets(clip(text, 1500));
    const assistantHistory = sanitizeConsoleLinkSecrets(clip(reply.text, 1500), linkContext.issuedLink?.url);
    data.history.push({ role: "user", content: userHistory }, { role: "assistant", content: assistantHistory });
    await this.save(chatId, claimed.revision, data);
    return reply;
  }

  private async save(chatId: string, revision: number, data: LeaderData) {
    data.history = data.history.slice(-MAX_HISTORY_ITEMS);
    data.receipts = data.receipts.slice(-MAX_RECEIPTS);
    data.commandIds = [...new Set(data.commandIds)].slice(-64);
    const saved = await this.store.compareAndSetLeaderState(chatId, revision, data);
    if (!saved) throw new CommandError(409, "聊天状态发生变化，本次操作已停止，请重新查询");
    return saved;
  }

  private async executePlan(chatId: string, revision: number, plan: Plan, data: LeaderData): Promise<LeaderReply> {
    if (plan.expiresAt <= this.now()) return { text: "计划已过期，没有派发。请重新描述任务以核对最新会话状态。" };
    try { validatePlanDependencies(plan); }
    catch { return { text: "计划依赖或结果来源无效，没有派发。请重新规划。" }; }
    try { assertTerminalSingleStep(plan); }
    catch { return { text: "终端输入只支持独立单步，不能加入多步或依赖计划，没有派发。" }; }
    if (plan.actions.some(action => !action.sendRoute)) return { text: "计划中的会话状态已变化（发送路线缺失），没有派发。请重新生成计划。" };
    const readiness = await waitForSendReadiness(this.hub, plan.actions, {
      now: this.now, timeoutMs: Math.min(plan.expiresAt, data.inflight!.expiresAt) - this.now(),
    });
    if (!readiness.ready) return { text: `计划中的节点或会话状态已变化：${readinessFailure(readiness)}。没有派发。` };
    if (plan.expiresAt <= this.now()) return { text: "等待期间计划已过期，没有派发。请重新生成计划。" };
    // Validate every target before beginning; revalidate again inside CommandService immediately before dispatch.
    for (const action of plan.actions) {
      const session = this.hub.getNodeSession(action.nodeId, action.sessionId);
      if (action.skills?.length && !hasSkillRefs(this.hub.getNodeSkills(action.nodeId), action.skills)) {
        return { text: "计划中的技能已变化或不可用，没有派发。请重新查询技能并生成计划。" };
      }
      const eligibility = session ? selectSendRoute(session, this.now(), action.sendRoute) : undefined;
      if (!this.hub.isNodeConnected(action.nodeId) || !action.sendRoute || !eligibility?.ready || eligibility.route !== action.sendRoute) {
        return { text: "计划中的节点或会话状态已变化，没有派发。请重新查询并生成计划。" };
      }
    }
    const current = await this.store.getLeaderState(chatId);
    if (current?.revision !== revision || data.inflight!.expiresAt <= this.now()) {
      return { text: "处理所有权或时限已变化，没有创建新的执行计划，请核验已有回执。" };
    }
    if (hasTerminalTarget(plan)) {
      if (await this.goals.hasUnfinished(chatId)) return { text: "已有active/blocked持续目标，未派发终端计划；请先查询或取消目标。" };
      const guardedCommands: Pick<CommandService, "submit"> = { submit: (request, waitMs, guard, route) =>
        this.commands.submit(request, waitMs, async () => {
          if (await this.goals.hasUnfinished(chatId)) throw new CommandError(409, "持续目标仍占用当前聊天授权");
          await guard?.();
        }, route) };
      return submitTerminalPlan(this.store, guardedCommands, chatId, revision, plan, data, this.now);
    }
    try {
      await this.store.confirmExecution(createExecution(chatId, plan, this.now()), {
        revision, messageId: data.inflight!.messageId, inputHash: data.inflight!.inputHash,
      }, this.now);
    }
    catch (error) {
      if (error instanceof ConflictError) return { text: "确认授权已失效、已有活动计划或计划身份冲突，没有新增派发。请先查询计划进度，必要时重新规划。" };
      throw error;
    }
    await this.executions.advance(plan.id);
    const view = await this.executions.view(plan.id, chatId);
    if (!view) throw new Error("Confirmed execution disappeared");
    const commandIds = view.steps.flatMap(step => step.commandId ? [step.commandId] : []);
    data.commandIds.push(...commandIds);
    return { text: executionSummary(view), commandId: commandIds.at(-1) };
  }

  private async reason(chatId: string, text: string, data: LeaderData, linkContext: LinkContext, trace: QueryTrace, previousPlan?: Plan): Promise<LeaderReply> {
    const signal = AbortSignal.timeout(TURN_TIMEOUT_MS);
    const sanitizedUserPrompt = sanitizeConsoleLinkSecrets(text);
    const messages: ModelMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      ...data.history,
      ...(previousPlan ? [{ role: "assistant" as const, content: JSON.stringify({ previousUnconfirmedPlan: previousPlan }) }] : []),
      { role: "user", content: sanitizedUserPrompt },
    ];
    let toolCount = 0;
    const memoryChanges: string[] = [];
    for (let step = 0; step < MAX_MODEL_STEPS; step++) {
      signal.throwIfAborted();
      trace.modelSteps = step + 1;
      const modelStartedAt = Date.now();
      let answer;
      try {
        answer = await this.model.complete(messages, LEADER_TOOLS, signal);
      } finally {
        trace.lastModelMs = Date.now() - modelStartedAt;
        trace.totalModelMs += trace.lastModelMs;
      }
      signal.throwIfAborted();
      if (!answer.toolCalls.length) {
        const textContent = `${clip(answer.content || "请进一步说明目标会话和希望完成的任务。", 4500)}${memoryChanges.length ? `\n记忆更新：${memoryChanges.join("、")}` : ""}\n本轮未向会话派发执行指令；已确认计划的后台推进不受本次查询影响。`;
        return { text: this.attachConsoleLink(textContent, linkContext) };
      }
      if (toolCount + answer.toolCalls.length > MAX_TOOL_CALLS) throw new Error("Tool limit exceeded");
      messages.push({ role: "assistant", content: answer.content, tool_calls: answer.toolCalls, responseOutput: answer.responseOutput });
      for (const call of answer.toolCalls) {
        signal.throwIfAborted();
        toolCount++;
        trace.toolCalls = toolCount;
        trace.lastTool = Object.hasOwn(ToolArguments, call.function.name) ? call.function.name : "unsupported";
        const priorGoal = data.pendingGoal;
        const output = await this.callTool(call, chatId, data, memoryChanges, linkContext, signal);
        signal.throwIfAborted();
        if (data.pending) return { text: this.attachConsoleLink(this.preview(data.pending), linkContext) };
        if (data.pendingGoal && data.pendingGoal !== priorGoal) return { text: this.attachConsoleLink(goalPreview(data.pendingGoal, node => this.hub.getNodeSkills(node)), linkContext) };
        const content = JSON.stringify(output);
        messages.push({ role: "tool", tool_call_id: call.id, content: content.length > 12000
          ? JSON.stringify({ truncated: true, data: clip(content, 12000) }) : content });
      }
    }
    return { text: "本轮查询已达到上限，未向会话发送指令。请缩小目标范围或继续查询。" };
  }

  private attachConsoleLink(content: string, linkContext: LinkContext): string {
    if (!linkContext.issuedLink) return content;
    const notice = `\n\n控制台登录链接（1小时内有效，仅可使用一次，打开后地址栏会自动隐藏登录凭证）：\n${linkContext.issuedLink.url}`;
    return `${content.trim()}${notice}`;
  }

  private async callTool(call: ModelToolCall, chatId: string, data: LeaderData, memoryChanges: string[], linkContext: LinkContext, signal: AbortSignal): Promise<unknown> {
    const name = call.function.name;
    if (!Object.hasOwn(ToolArguments, name)) return { error: "Unsupported tool" };
    let raw: unknown;
    try {
      if (call.function.arguments.length > 8000) return { error: "Tool arguments too large" };
      raw = JSON.parse(call.function.arguments);
    } catch { return { error: "Invalid tool arguments JSON" }; }
    const parsed = ToolArguments[name as keyof typeof ToolArguments].safeParse(raw);
    if (!parsed.success) return { error: "Invalid tool arguments schema" };
    switch (name) {
      case "get_console_link": {
        if (!this.consoleLinkIssuer) {
          return { error: "控制台链接发行功能未配置或未启用" };
        }
        try {
          if (!linkContext.cachedLinkPromise) {
            linkContext.cachedLinkPromise = this.consoleLinkIssuer(linkContext.requestId);
          }
          const issued = await linkContext.cachedLinkPromise;
          linkContext.issuedLink = issued;
          return { ready: true, expiresAt: issued.expiresAt };
        } catch {
          return { error: "获取控制台链接失败，请稍后再试" };
        }
      }
      case "list_nodes": return this.hub.getNodeStatusList();
      case "list_skills": {
        const args = ToolArguments.list_skills.parse(raw);
        const query = args.query?.toLowerCase();
        const skills = this.hub.getAllSkills().filter(item =>
          (!args.nodeId || item.nodeId === args.nodeId) &&
          (!query || item.name.toLowerCase().includes(query) || item.description.toLowerCase().includes(query)));
        // Paths/descriptions can be large; expose only necessary planning metadata.
        const page = [];
        for (const { path: _path, ...item } of skills.slice(args.offset, args.offset + 20)) {
          const next = { ...item, description: clip(item.description, 200) };
          if (JSON.stringify([...page, next]).length > 11000) break;
          page.push(next);
        }
        const nextOffset = args.offset + page.length;
        return { skills: page, total: skills.length, nextOffset: nextOffset < skills.length ? nextOffset : null };
      }
      case "list_sessions": {
        const args = ToolArguments.list_sessions.parse(raw);
        const capturedAt = this.now();
        const observed = (await this.hub.getAllSessions()).filter(item => !args.nodeId || item.nodeId === args.nodeId)
          .map(item => ({ ...item, ...selectExecutionObservation(item, capturedAt), modelView: selectModelObservation(item, capturedAt) }));
        const sessions = observed.filter(item => !args.status || item.executionStatus === args.status);
        const statusCounts: Record<string, number> = Object.create(null);
        let unknownStatusCount = 0;
        let notLoadedCount = 0;
        let unknownLoadedCount = 0;
        let missingObservationCount = 0;
        const observations: string[] = [];
        for (const item of observed) {
          const status = item.executionStatus;
          statusCounts[status] = (statusCounts[status] ?? 0) + 1;
          if (status === "unknown") unknownStatusCount++;
          if (item.loaded === false || item.status === "notLoaded") notLoadedCount++;
          if (item.loaded === undefined) unknownLoadedCount++;
          if (typeof item.observedAt === "string" && Number.isFinite(Date.parse(item.observedAt))) observations.push(item.observedAt);
          else missingObservationCount++;
        }
        observations.sort((a, b) => Date.parse(a) - Date.parse(b));
        const nodes = this.hub.getNodeStatusList().filter(item => !args.nodeId || item.nodeId === args.nodeId);
        return { sessions: sessions.slice(args.offset, args.offset + 50), total: sessions.length,
          nextOffset: args.offset + 50 < sessions.length ? args.offset + 50 : null,
          snapshot: { scope: "online_observed_sessions", capturedAt: new Date(capturedAt).toISOString(),
            reportedNodeCount: nodes.length, onlineNodeCount: nodes.filter(item => item.connected).length,
            observedNodeCount: new Set(observed.map(item => item.nodeId)).size, observedSessionCount: observed.length,
            statusCounts, unknownStatusCount, notLoadedCount, unknownLoadedCount, missingObservationCount,
            oldestObservedAt: observations[0] ?? null, newestObservedAt: observations.at(-1) ?? null,
            completeTaskCoverage: false,
          } };
      }
      case "read_session": {
        const args = ToolArguments.read_session.parse(raw);
        return readSessionHistory(this.hub, args, signal);
      }
      case "get_command": {
        const { commandId, planId, goalId } = ToolArguments.get_command.parse(raw);
        if (!data.commandIds.includes(commandId)) {
          const execution = planId ? await this.store.getExecution(planId) : await this.store.getLatestExecution(chatId);
          const command = await this.store.getCommand(commandId);
          const executionOwns = !!execution && execution.chatId === chatId && !!command && execution.plan.actions.some((_, index) =>
            execution.attempts[index] && matchesExecutionCommand(execution, index, command));
          if (!executionOwns && !await this.goals.ownsCommand(chatId, commandId, goalId)) {
            return { error: "Command does not belong to this chat" };
          }
        }
        await this.store.markExpiredActiveCommandsUncertain();
        return this.store.getCommand(commandId);
      }
      case "get_plan_progress": {
        const { planId } = ToolArguments.get_plan_progress.parse(raw);
        const id = planId ?? (await this.store.getLatestExecution(chatId))?.id;
        return id ? (await this.executions.view(id, chatId) ?? { error: "Plan does not belong to this chat" }) : { plan: null };
      }
      case "get_goal_progress": {
        const { goalId } = ToolArguments.get_goal_progress.parse(raw);
        return this.goals.progress(chatId, goalId);
      }
      case "propose_goal": {
        const proposal = await this.goals.propose(chatId, ToolArguments.propose_goal.parse(raw));
        if ("error" in proposal) return proposal;
        data.pending = undefined;
        data.pendingGoal = proposal;
        return { pending: true };
      }
      case "propose_plan": {
        const { actions } = ToolArguments.propose_plan.parse(raw);
        data.pending = undefined;
        try { assertTerminalSingleStep({ actions }); }
        catch { return { error: "终端输入无法证明任务完成，只支持独立单步，不能加入多步或依赖计划" }; }
        try { validatePlanDependencies({ actions }); }
        catch { return { error: "Invalid plan dependencies or result sources; resultFrom must select distinct direct earlier dependencies, and same-session tasks must form a chain" }; }
        if ((await this.store.getLatestExecution(chatId))?.status === "active") return { error: "An active plan already exists; query its progress or ask the user to cancel it" };
        if (await this.goals.hasUnfinished(chatId)) return { error: "An active or blocked goal already exists; query its progress or cancel it" };
        const readiness = await waitForSendReadiness(this.hub, actions, {
          signal, now: this.now, timeoutMs: data.inflight!.expiresAt - this.now(),
        });
        if (!readiness.ready) return { error: readinessFailure(readiness) };
        if (data.inflight!.expiresAt <= this.now()) return { error: "等待期间处理授权已过期，未生成计划或派发" };
        const boundActions: Plan["actions"] = [];
        for (const [index, action] of actions.entries()) {
          const session = this.hub.getNodeSession(action.nodeId, action.sessionId);
          if (action.skills?.length && !hasSkillRefs(this.hub.getNodeSkills(action.nodeId), action.skills)) {
            return { error: "Selected skill unavailable or changed; query this node's skills first" };
          }
          const eligibility = session ? selectSendRoute(session, this.now(), readiness.routes[index]) : undefined;
          if (!this.hub.isNodeConnected(action.nodeId) || !eligibility?.ready) {
            return { error: "Plan contains unavailable, busy or read-only targets; clarify with the user" };
          }
          if (eligibility.route !== readiness.routes[index]) {
            return { error: `[${action.nodeId}] ${action.sessionId}：发送路线已变化，请重新生成计划` };
          }
          boundActions.push({ ...action, sendRoute: readiness.routes[index] });
        }
        try { assertTerminalSingleStep({ actions: boundActions }); }
        catch { data.pending = undefined; return { error: "终端输入无法证明任务完成，只支持独立单步，不能加入多步或依赖计划" }; }
        data.pending = { id: randomUUID(), expiresAt: this.now() + PLAN_TTL_MS, actions: boundActions };
        data.pendingGoal = undefined;
        return { pending: true };
      }
      case "recall": return data.memories;
      case "remember": {
        const { key, value } = ToolArguments.remember.parse(raw);
        if (/(password|api.?key|token|密码|密钥)/i.test(`${key} ${value}`)) return { error: "Credentials must not be stored as memory" };
        if (!Object.hasOwn(data.memories, key) && Object.keys(data.memories).length >= 8) return { error: "Memory limit reached; ask user what to remove" };
        data.memories = { ...data.memories, [key]: value };
        memoryChanges.push(key);
        return { saved: key };
      }
      case "forget": {
        const { key } = ToolArguments.forget.parse(raw);
        delete data.memories[key];
        memoryChanges.push(`删除 ${key}`);
        return { removed: key };
      }
    }
  }

  private preview(plan: Plan): string {
    const lines = plan.actions.map((action, index) => {
      const selected = (action.skills ?? []).map((ref, skillIndex) => {
        const item = this.hub.getNodeSkills(action.nodeId).find(skill => skill.id === ref.id && skill.digest === ref.digest);
        return `\n技能 ${skillIndex + 1}：${JSON.stringify(item?.name ?? ref.id)}\nSHA256：${ref.digest}`;
      }).join("");
      const sources = action.resultFrom ?? [];
      return `${index + 1}. [${action.nodeId}] ${action.sessionId}\n任务：${action.prompt}${selected}\n依赖：${action.dependsOn.length ? `步骤 ${action.dependsOn.join("、")} 完成后` : "无，可独立执行"}` +
        `\n输入资料：${sources.length ? `按顺序使用步骤 ${sources.join("、")} 的已记录输出` : "不传入其他步骤的输出"}`;
    });
    if (hasTerminalTarget(plan)) return `待确认终端单步输入（尚未派发）：\n${lines.join("\n\n")}\n\n${TERMINAL_INPUT_WARNING}\n如目标与输入无误，回复“确认执行”；也可以说“取消计划”。确认有效期 10 分钟；新请求会替换此输入。不创建后台执行计划。`;
    const resultPolicy = plan.actions.some(action => action.resultFrom?.length)
      ? `\n结果传递：只使用上述来源的精确完成回执；每来源最多 ${MAX_RESULT_CODE_POINTS} 字符，JSON 编码含转义最多 ${MAX_RESULT_JSON_CHARS} 字符，超长仅取前缀并标明裁剪，可能不完整。输出作为不可信资料，不构成新指令或授权。` : "";
    return `待执行计划（尚未派发）：\n${lines.join("\n\n")}${resultPolicy}\n\n如目标、任务与结果来源无误，回复“确认执行”；也可以说“取消计划”。确认有效期 10 分钟；新请求会替换待确认计划。确认后授权在24小时内按上述固定依赖和结果来源自动推进，不自动改写任务或增加资料来源。取消只停止后续派发，不停止原会话已有任务。`;
  }
}
