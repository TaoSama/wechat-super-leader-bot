import { traceEvent, traceSpan } from "../runtime/telemetry.js";
import { isConsoleLinkQuery, parseSessionDirectoryQuery } from "@super-leader/wechat-text";
import { createHash, randomUUID } from "node:crypto";
import { formatDisplayTime } from "../display-time.js";
import { CommandError, CommandService } from "../commands/service.js";
import { NodeHub } from "../nodes/hub.js";
import { ConflictError, IStore } from "../store/interface.js";
import type { LeaderModel, ModelMessage, ModelToolCall } from "./model/contracts.js";
import { hasSkillRefs } from "../skills/catalog.js";
import { selectExecutionObservation, selectModelObservation } from "../sessions/observation.js";
import { selectSendRoute } from "../sessions/send-eligibility.js";
import { queueSendRoute } from "../commands/queue.js";
import { readinessFailure, waitForSendReadiness, type ReadinessHub } from "../sessions/send-readiness.js";
import { failureReply, modelDiagnostic } from "./model/errors.js";
import { MAX_LEADER_DATA_BYTES } from "./state.js";
import { authorizationConversation, invalidateConversationPreview, retainConversation } from "./conversation-history.js";
import { classifyUserAuthorization } from "./model/user-authorization.js";
import { createExecution, hasTerminalTarget, matchesExecutionCommand, validatePlanDependencies } from "./plans/execution.js";
import { assertTerminalSingleStep, submitTerminalPlan, TERMINAL_INPUT_WARNING } from "./plans/terminal.js";
import { ExecutionScheduler } from "./plans/scheduler.js";
import { executionSummary, sessionLabels } from "./plans/presentation.js";
import { readSessionHistory } from "./queries/session-history.js";
import { SessionTitles } from "./queries/session-titles.js";
import { authorizeImageDelivery, sendSessionImages } from "./queries/session-images.js";
import type { MediaHub } from "../sessions/message-images.js";
import { GoalConversation, goalConfirmation, goalCancellation } from "./goals/conversation.js";
import { GoalScheduler } from "./goals/scheduler.js";
import { createGoalDecider } from "./goals/model.js";
import { goalPreview } from "./goals/presentation.js";
import { generateAcknowledgement, generateAutomationAcknowledgement, type AutomationTurn } from "./acknowledgement.js";
import type { GoalProposal } from "./goals/goal.js";
import { readGoalView } from "./goals/view.js";
import type { AutomationService } from "../automations/service.js";
import { AUTOMATION_TOOLS, AUTOMATION_TOOL_NAMES, executeAutomationTool } from "../automations/tools.js";
import { classifyAutomationAuthorization, type AutomationOperation } from "./model/automation-authorization.js";
import { BackgroundSpecSchema } from "../background/contracts.js";
import { classifyBackgroundAuthorization } from "./model/background-authorization.js";
import { assertBackgroundSourcesDiscovered, BACKGROUND_INSTRUCTIONS, BACKGROUND_TOOLS, BACKGROUND_TOOL_NAMES,
  confirmBackgroundMutations, executeBackgroundTool, recoverBackgroundFollowups, type BackgroundToolAuthority, type BackgroundToolService, type BackgroundTurn } from "./background-tools.js";
import {
  CLAIM_TTL_MS, ConsoleLinkIssued, ConsoleLinkIssuer, LEADER_TOOLS, LeaderData, LeaderDataSchema, LeaderReply,
  MAX_MODEL_STEPS, MAX_RECEIPTS, MAX_REPLY_CHARS, MAX_RESULT_CODE_POINTS, MAX_RESULT_JSON_CHARS, MAX_TOOL_CALLS, PLAN_TTL_MS, Plan,
  SYSTEM_PROMPT, TURN_TIMEOUT_MS, ToolArguments,
} from "./contracts.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const MAX_BACKGROUND_TOOL_ARGUMENT_CHARS = 160_000;
const MAX_STANDARD_TOOL_ARGUMENT_CHARS = 8_000;
const MAX_SESSION_TOOL_RESULT_CHARS = 12000;
const clip = (text: string, length: number) => {
  const value = text.slice(0, length);
  return /[\uD800-\uDBFF]$/.test(value) ? value.slice(0, -1) : value;
};
const confirmation = /^(?:请)?(?:确认|执行|开始|开始执行|确认执行|确认开始|按这个计划执行|就按这个执行|确认这个计划)[。！!]?$/;
const naturalConfirmation = /^(?:是|是的|对|对的|没错|好的|好|可以|就这样|就这个|就是这个|就是它|嗯|嗯嗯)[。！!]?$/;
const cancellation = /^(?:请|帮我)?(?:取消计划|不用执行|取消执行|停止后续任务|停止后续执行|先别跑后面的任务)[。！!]?$/;
type Hub = Pick<NodeHub, "getAllSessions" | "getNodeStatusList" | "getNodeSession" | "isNodeConnected" | "getAllSkills" | "getNodeSkills" | "readHistory"> & ReadinessHub & Partial<MediaHub>
  & Partial<Pick<NodeHub, "listAutomations" | "inspectAutomation">>;


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
const MAX_DIRECTORY_REPLY_CHARS = 16000;
type ReasonedReply = LeaderReply & { directory?: boolean; execution?: { plan: Plan } | { goal: GoalProposal } };

export class LeaderOrchestrator {
  private active = new Map<string, { messageId: string; inputHash: string; promise: Promise<LeaderReply> }>();
  private executions: ExecutionScheduler;
  private goals: GoalConversation;
  constructor(private store: IStore, private hub: Hub, private commands: Pick<CommandService, "submit">,
    private model: LeaderModel, private now: () => number = Date.now, private consoleLinkIssuer?: ConsoleLinkIssuer,
    executions?: ExecutionScheduler, goals?: GoalScheduler, private automations?: AutomationService,
    private background?: BackgroundToolService) {
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
      return { text: receipt.text, commandId: receipt.commandId, ...(receipt.images ? { images: receipt.images } : {}) };
    }
    if (data.inflight) {
      if (data.inflight.expiresAt > this.now()) throw new CommandError(409, "上一条请求尚未结束，请稍后查询");
      const prior = data.inflight;
      const recovered = prior.plan ? await this.executions.view(prior.plan.id, chatId) : null;
      for (const step of recovered?.steps ?? []) if (step.commandId) data.commandIds.push(step.commandId);
      let automationRecovery: string | undefined;
      if (this.automations && !prior.plan && !prior.goal) {
        try {
          const schedules = (await this.automations.repository.list(chatId)).filter(schedule => schedule.authorizedMessageId === prior.messageId);
          if (schedules.length) automationRecovery = (await this.confirmAutomations(chatId, prior.messageId, {
            attempted: true, ids: new Set(schedules.map(schedule => schedule.id)), errors: [],
          })).text;
        } catch { automationRecovery = "定时任务持久记录暂不可读，提交情况尚待核查，不自动重建。"; }
      }
      let backgroundRecovery: string | undefined;
      if (this.background && !prior.plan && !prior.goal) {
        try { backgroundRecovery = await recoverBackgroundFollowups(this.background, chatId, prior.messageId); }
        catch { backgroundRecovery = "后台操作持久记录暂不可读，提交情况尚待核查，不自动重复提交。"; }
      }
      const mutationRecovery = [automationRecovery, backgroundRecovery].filter(Boolean).join("\n");
      const recoveryText = `上次对话处理被中断，未自动重试原指令。${mutationRecovery || (prior.goal ? await this.goals.recovery(chatId, prior.goal.id) : recovered
        ? `已确认计划仍按持久记录核查与推进：\n${executionSummary(recovered)}`
        : this.background ? "尚未核对到本轮追问回执；后台任务及延期情况请查询任务记录，不自动重试。"
          : "尚无可确认的持久执行记录，不自动创建或派发。请先核查会话状态。")}`;
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
    const confirmationTime = this.now();
    const livePlan = previousPlan && previousPlan.expiresAt > confirmationTime ? previousPlan : undefined;
    const liveGoal = data.pendingGoal && data.pendingGoal.expiresAt > confirmationTime ? data.pendingGoal : undefined;
    if (previousPlan && !livePlan) invalidateConversationPreview(data.history, previousPlan.id);
    if (data.pendingGoal && !liveGoal) invalidateConversationPreview(data.history, data.pendingGoal.id);
    const displayedPreview = data.history.at(-1)?.role === "assistant" ? data.history.at(-1)?.confirmationFor : undefined;
    const confirmsDisplayedPreview = !!displayedPreview && (displayedPreview === livePlan?.id || displayedPreview === liveGoal?.id);
    const onlyExpiredPreview = !livePlan && !liveGoal && !!(previousPlan || data.pendingGoal);
    const confirms = confirmation.test(text.trim()) || naturalConfirmation.test(text.trim()) && (confirmsDisplayedPreview || onlyExpiredPreview);
    const goalId = goalConfirmation(text.trim());
    const ambiguous = confirms && !!livePlan && !!liveGoal;
    const plan = confirms && !ambiguous ? livePlan ?? (liveGoal ? undefined : previousPlan) : undefined;
    const goal = goalId ? data.pendingGoal?.id === goalId ? data.pendingGoal : undefined
      : confirms && !ambiguous && !plan ? data.pendingGoal : undefined;
    if (plan || data.pending && data.pending.expiresAt <= confirmationTime) data.pending = undefined;
    if (goal || data.pendingGoal && data.pendingGoal.expiresAt <= confirmationTime) data.pendingGoal = undefined;
    data.inflight = { messageId, inputHash, expiresAt: this.now() + CLAIM_TTL_MS, plan, goal };
    let claimed = await this.save(chatId, saved?.revision ?? 0, data);
    let reply: LeaderReply;
    let directory = false;
    let invalidatedConfirmation = false;
    const linkContext: LinkContext = {
      requestId: `console_link_${hash([chatId, messageId])}`,
    };
    if (ambiguous) {
      reply = { text: "当前同时有计划和持续目标待确认，请先取消其中一项，再确认要执行的内容。" };
    } else if (goalCancellation(text.trim())) {
      invalidatedConfirmation = true;
      data.pendingGoal = undefined;
      reply = await this.goals.cancel(chatId);
    } else if (goal || goalId || text.trim().startsWith("确认目标")) {
      reply = goal ? await this.confirmGoal(chatId, claimed.revision, goal, data)
        : { text: "没有该ID的待确认目标；未派发。请先核对目标预览，并回复‘确认目标 <UUID>’。" };
    } else if (cancellation.test(text.trim())) {
      invalidatedConfirmation = true;
      data.pending = undefined;
      const hadPendingGoal = !!data.pendingGoal;
      data.pendingGoal = undefined;
      if (hadPendingGoal || await this.goals.hasUnfinished(chatId)) {
        reply = await this.goals.cancel(chatId);
      } else {
        const latest = await this.store.getLatestExecution(chatId);
        const cancelled = latest?.status === "active" ? await this.executions.cancel(latest.id, chatId) : null;
        reply = { text: cancelled ? `已取消待确认计划；以下已确认计划停止后续派发。\n${executionSummary(cancelled)}`
          : "已取消待确认计划；当前没有活动执行计划。没有新增派发，不会停止原会话已有任务。" };
      }
    } else if (confirms && (plan || !authorizationConversation(data.history).length)) {
      reply = plan ? await this.executePlan(chatId, claimed.revision, plan, data)
        : { text: "当前没有待确认计划。请告诉我希望哪些会话完成什么任务。" };
    } else {
      const memoriesBefore = { ...data.memories };
      const startedAt = Date.now();
      const reference = hash([chatId, messageId]).slice(0, 12);
      const trace: QueryTrace = { modelSteps: 0, toolCalls: 0, totalModelMs: 0 };
      const automationTurn: AutomationTurn = { attempted: false, ids: new Set(), errors: [] };
      const backgroundTurn: BackgroundTurn = { mutations: [], errors: [] };
      let execution: ReasonedReply["execution"];
      try {
        const reasoned = await this.reason(chatId, text, data, linkContext, trace, previousPlan, automationTurn, claimed.revision, backgroundTurn);
        execution = reasoned.execution;
        directory = reasoned.directory ?? false;
        reply = { text: reasoned.text, commandId: reasoned.commandId, ...(reasoned.images ? { images: reasoned.images } : {}) };
      } catch (error) {
        if (error instanceof ConflictError) throw error;
        console.warn(automationTurn.attempted || backgroundTurn.mutations.length ? 'Leader processing failed after a background or automation operation; checking persisted receipts' : 'Leader processing failed; no plan dispatched', {
          requestRef: reference, elapsedMs: Date.now() - startedAt, ...trace, ...modelDiagnostic(error),
        });
        data.memories = memoriesBefore;
        data.pending = previousPlan && previousPlan.expiresAt > this.now() ? previousPlan : undefined;
        data.pendingGoal = pendingGoalBefore && pendingGoalBefore.expiresAt > this.now() ? pendingGoalBefore : undefined;
        reply = automationTurn.attempted || backgroundTurn.mutations.length
          ? await this.confirmMutations(chatId, messageId, automationTurn, backgroundTurn)
          : { text: failureReply(error, reference) };
      }
      if (execution) {
        data.pending = undefined;
        data.pendingGoal = undefined;
        if (data.inflight!.expiresAt <= this.now()) {
          reply = { text: "本次请求已超时，未派发任务，请重新下达指令。" };
        } else {
          // Freeze the original user's request under the same claim before dispatch.
          // Execution errors stay outside the model catch: a persisted attempt must
          // never be reported as a harmless query failure or retried automatically.
          data.inflight = { ...data.inflight!, ...execution };
          claimed = await this.save(chatId, claimed.revision, data);
          reply = "plan" in execution
            ? await this.executePlan(chatId, claimed.revision, execution.plan, data)
            : await this.confirmGoal(chatId, claimed.revision, execution.goal, data);
          reply.text = this.attachConsoleLink(reply.text, linkContext);
        }
      }
    }
    // Confirmation must never authorize steps or skill versions hidden by clipping.
    if ((data.pending && data.pending !== previousPlan || data.pendingGoal && data.pendingGoal !== pendingGoalBefore) && reply.text.length > MAX_REPLY_CHARS) {
      data.pending = undefined;
      data.pendingGoal = undefined;
      invalidatedConfirmation = true;
      reply = { text: this.attachConsoleLink("计划内容过长，无法完整展示供确认，未保存待确认计划，也未派发。请缩短任务内容或分批提出。", linkContext) };
    }
    reply.text = clip(reply.text, directory ? MAX_DIRECTORY_REPLY_CHARS : MAX_REPLY_CHARS);
    data.inflight = undefined;
    data.receipts.push({ messageId, inputHash, ...reply });
    const userHistory = sanitizeConsoleLinkSecrets(text);
    const assistantHistory = sanitizeConsoleLinkSecrets(reply.text, linkContext.issuedLink?.url);
    const confirmationFor = data.pending && data.pending !== previousPlan ? data.pending.id
      : data.pendingGoal && data.pendingGoal !== pendingGoalBefore ? data.pendingGoal.id : undefined;
    data.history.push({ role: "user", content: userHistory, complete: true }, {
      role: "assistant", content: assistantHistory, complete: true, ...(confirmationFor ? { confirmationFor } : {}),
      ...(invalidatedConfirmation ? { invalidatedConfirmation: true } : {}),
    });
    await this.save(chatId, claimed.revision, data);
    traceEvent("leader.completed", { outputChars: reply.text.length, commandId: reply.commandId });
    return reply;
  }

  private async save(chatId: string, revision: number, data: LeaderData) {
    data.history = retainConversation(data.history);
    data.receipts = data.receipts.slice(-MAX_RECEIPTS);
    data.commandIds = [...new Set(data.commandIds)].slice(-64);
    while (data.history.length && Buffer.byteLength(JSON.stringify(data), "utf8") > MAX_LEADER_DATA_BYTES) {
      data.history = data.history.slice(2);
    }
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
    const readiness = hasTerminalTarget(plan) ? await waitForSendReadiness(this.hub, plan.actions, {
      now: this.now, timeoutMs: Math.min(plan.expiresAt, data.inflight!.expiresAt) - this.now(),
    }) : {ready:true as const};
    if (!readiness.ready) return { text: `计划中的节点或会话状态已变化：${readinessFailure(readiness)}。没有派发。` };
    if (plan.expiresAt <= this.now()) return { text: "等待期间计划已过期，没有派发。请重新生成计划。" };
    // Validate every target before beginning; revalidate again inside CommandService immediately before dispatch.
    for (const action of plan.actions) {
      const session = this.hub.getNodeSession(action.nodeId, action.sessionId) ?? await this.store.getKnownSession(action.nodeId,action.sessionId);
      if (action.skills?.length && this.hub.isNodeConnected(action.nodeId) && !hasSkillRefs(this.hub.getNodeSkills(action.nodeId), action.skills)) {
        return { text: "计划中的技能已变化或不可用，没有派发。请重新查询技能并生成计划。" };
      }
      const route = session && queueSendRoute(session,action.sendRoute);
      if (!action.sendRoute || !route || route !== action.sendRoute) {
        return { text: "计划中的节点或会话状态已变化，没有派发。请重新查询并生成计划。" };
      }
    }
    const current = await this.store.getLeaderState(chatId);
    if (current?.revision !== revision || data.inflight!.expiresAt <= this.now()) {
      return { text: "处理所有权或时限已变化，没有创建新的执行计划，请核验已有回执。" };
    }
    if (plan.actions.length === 1 && plan.actions[0].deliveryMode === "steer") {
      const action = plan.actions[0];
      const command = await this.commands.submit({nodeId:action.nodeId,sessionId:action.sessionId,action:"send",prompt:action.prompt,
        skills:action.skills,deliveryMode:"steer",expectedTurnId:action.expectedTurnId,requestId:`leader_steer_${hash([chatId,plan.id])}`},0,async()=>{
        const latest = await this.store.getLeaderState(chatId);
        const inflight = latest && LeaderDataSchema.parse(latest.data).inflight;
        if (latest?.revision !== revision || !inflight || inflight.expiresAt<=this.now() || JSON.stringify(inflight.plan)!==JSON.stringify(plan)) {
          throw new CommandError(409,"Current-turn supplement authority changed");
        }
      },action.sendRoute,{type:"chat",chatId});
      data.commandIds.push(command.commandId);
      const fallbackText = command.status === "accepted" ? "补充已由原会话当前轮受理，执行情况尚待核查。" : `当前轮补充${command.status === "queued" ? "已保存，等待核对原轮次" : "结果待核查"}；不会改成新任务或重复发送。`;
      return { text: await generateAcknowledgement(this.model, this.store, this.hub, {
        mode: "steer", durableState: { planId: plan.id, status: "submitted" },
        targets: [{ ...action, commandId: command.commandId }], fallbackText,
      }), commandId: command.commandId };
    }
    if (hasTerminalTarget(plan)) {
      if (await this.goals.hasUnfinished(chatId)) return { text: "已有active/blocked持续目标，未派发终端计划；请先查询或取消目标。" };
      const guardedCommands: Pick<CommandService, "submit"> = { submit: (request, waitMs, guard, route) =>
        this.commands.submit(request, waitMs, async () => {
          if (await this.goals.hasUnfinished(chatId)) throw new CommandError(409, "持续目标仍占用当前聊天授权");
          await guard?.();
        }, route) };
      const submitted = await submitTerminalPlan(this.store, guardedCommands, chatId, revision, plan, data, this.now);
      if (!submitted.commandId) return submitted;
      return { ...submitted, text: await generateAcknowledgement(this.model, this.store, this.hub, {
        mode: "terminal", durableState: { planId: plan.id, executionConfirmed: false, atomic: false },
        targets: [{ ...plan.actions[0], commandId: submitted.commandId }], fallbackText: submitted.text,
      }) };
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
    return { text: await generateAcknowledgement(this.model, this.store, this.hub, {
      mode: "plan", durableState: { planId: view.id, status: view.status,
        steps: view.steps.map(({ step, nodeId, sessionId, prompt, status, dependsOn }) => ({ step, nodeId, sessionId, prompt, status, dependsOn })) },
      targets: view.steps.map(({ nodeId, sessionId, commandId }) => ({ nodeId, sessionId, commandId })),
      fallbackText: executionSummary(view, (nodeId, sessionId) => this.hub.getNodeSession(nodeId, sessionId)?.title),
    }), commandId: commandIds.at(-1) };
  }

  private async confirmGoal(chatId: string, revision: number, proposal: GoalProposal, data: LeaderData): Promise<LeaderReply> {
    const reply = await this.goals.confirm(chatId, revision, proposal, data);
    const goal = await this.store.getGoal(proposal.id);
    if (!goal || goal.chatId !== chatId) return reply;
    const view = await readGoalView(this.store, goal, this.now());
    const commands = await Promise.all(view.actions.filter(action => action.commandId).map(action => this.store.getCommand(action.commandId!)));
    return { ...reply, text: await generateAcknowledgement(this.model, this.store, this.hub, {
      mode: "goal", durableState: { goalId: goal.id, status: goal.status, objective: proposal.objective,
        actionCount: goal.actions.length, decisionAttempts: goal.decisionAttempts,
        maxActions: proposal.maxActions, maxDecisions: proposal.maxDecisions,
        actions: view.actions.map(({ index, target, status, commandId }) => ({ index, target, status, commandId })) },
      targets: proposal.targets.map(target => ({ ...target,
        commandId: commands.filter(command => command?.nodeId === target.nodeId && command.sessionId === target.sessionId).at(-1)?.commandId })),
      fallbackText: reply.text,
    }) };
  }

  private confirmAutomations(chatId: string, messageId: string, turn: AutomationTurn): Promise<LeaderReply> {
    return generateAutomationAcknowledgement(this.model, this.store, this.hub, this.automations!, chatId, messageId, turn);
  }

  private async confirmMutations(chatId: string, messageId: string, automationTurn: AutomationTurn, backgroundTurn: BackgroundTurn): Promise<LeaderReply> {
    const notices: string[] = [];
    if (automationTurn.attempted) notices.push((await this.confirmAutomations(chatId, messageId, automationTurn)).text);
    if (backgroundTurn.mutations.length && this.background) notices.push(await confirmBackgroundMutations(this.background, chatId, backgroundTurn));
    return { text: notices.join("\n\n") };
  }

  private async reason(chatId: string, text: string, data: LeaderData, linkContext: LinkContext, trace: QueryTrace, previousPlan?: Plan,
    automationTurn: AutomationTurn = { attempted: false, ids: new Set(), errors: [] }, claimRevision?: number,
    backgroundTurn: BackgroundTurn = { mutations: [], errors: [] }): Promise<ReasonedReply> {
    const signal = AbortSignal.timeout(TURN_TIMEOUT_MS);
    const sanitizedUserPrompt = sanitizeConsoleLinkSecrets(text);
    const directoryQuery = parseSessionDirectoryQuery(text);
    if (directoryQuery) {
      const titles = new SessionTitles();
      await traceSpan("leader.tool", () => this.callTool({ id: "session-directory", type: "function",
        function: { name: "list_sessions", arguments: JSON.stringify(directoryQuery) } },
      chatId, data, [], linkContext, signal, titles), { tool: "list_sessions", source: "direct_directory" });
      signal.throwIfAborted();
      return { text: titles.render(""), directory: true };
    }
    if (isConsoleLinkQuery(text)) {
      await traceSpan("leader.tool", () => this.callTool({ id: "console-link", type: "function",
        function: { name: "get_console_link", arguments: "{}" } },
      chatId, data, [], linkContext, signal, new SessionTitles()), { tool: "get_console_link", source: "direct_console" });
      signal.throwIfAborted();
      return { text: linkContext.issuedLink ? this.attachConsoleLink("控制台", linkContext)
        : "暂时无法获取控制台链接，请稍后再试。" };
    }
    const assertCurrentAuthority = async () => {
      signal.throwIfAborted();
      const current = await this.store.getLeaderState(chatId);
      const inflight = current && LeaderDataSchema.parse(current.data).inflight;
      if (current?.revision !== claimRevision || !inflight || inflight.expiresAt <= this.now() ||
          inflight.messageId !== data.inflight?.messageId || inflight.inputHash !== data.inflight?.inputHash) {
        throw new CommandError(409, "后台或定时操作的本轮处理授权已失效，未继续提交。");
      }
    };
    const backgroundAuthority: BackgroundToolAuthority = { chatId, currentMessageId: data.inflight!.messageId,
      operations: new Set(), discoveredRunIds: new Set(), discoveredSources: new Map(), assertCurrentAuthority,
      onMutationAttempt: mutation => { backgroundTurn.mutations.push(mutation); } };
    const sessionTitles = new SessionTitles();
    const messages: ModelMessage[] = [
      { role: "system", content: this.automations ? `${SYSTEM_PROMPT}\n定时任务工具已配置。当前时间：${formatDisplayTime(this.now())}；默认时区Asia/Shanghai，用户明确指定时区时使用该时区。仅用户本轮明确要求才创建、暂停、恢复或取消定时任务；查询使用list_automations/automation_runs。时间、会话或意图含糊时先澄清，已有提醒不能因查询而重建。创建成功仅表示已保存等待调度，未来触发不等于已启动会话；不要对同一请求反复创建。开始默认静默，监控无变化不通知。` : SYSTEM_PROMPT },
      ...(this.background ? [{ role: "system" as const, content: `${BACKGROUND_INSTRUCTIONS}\nkind=background 的任务参数放入 background 对象。立即后台执行使用 timing.type=at 和当前时间，不转换为向源会话派发的计划。` }] : []),
      ...data.history.map(({ role, content }) => ({ role, content })),
      ...(previousPlan ? [{ role: "assistant" as const, content: JSON.stringify({ previousUnconfirmedPlan: previousPlan }) }] : []),
      { role: "user", content: sanitizedUserPrompt },
    ];
    let toolCount = 0;
    let authorization: ReturnType<typeof classifyUserAuthorization> | undefined;
    let automationAuthorization: ReturnType<typeof classifyAutomationAuthorization> | undefined;
    let backgroundAuthorization: ReturnType<typeof classifyBackgroundAuthorization> | undefined;
    const currentUserIntent = async () => {
      if (!authorization) {
        const authorizationStartedAt = Date.now();
        authorization = classifyUserAuthorization(this.model, sanitizedUserPrompt, signal, data.history);
        try { await authorization; }
        finally {
          trace.lastModelMs = Date.now() - authorizationStartedAt;
          trace.totalModelMs += trace.lastModelMs;
        }
      }
      return authorization;
    };
    const memoryChanges: string[] = [];
    for (let step = 0; step < MAX_MODEL_STEPS; step++) {
      signal.throwIfAborted();
      trace.modelSteps = step + 1;
      const modelStartedAt = Date.now();
      let answer;
      try {
        answer = await traceSpan("leader.model", () => this.model.complete(messages,
          [...LEADER_TOOLS, ...(this.automations ? AUTOMATION_TOOLS : []), ...(this.background ? BACKGROUND_TOOLS : [])], signal), { purpose: "reason", attempt: step });
      } finally {
        trace.lastModelMs = Date.now() - modelStartedAt;
        trace.totalModelMs += trace.lastModelMs;
      }
      signal.throwIfAborted();
      if (!answer.toolCalls.length) {
        const textContent = `${clip(answer.content || "请进一步说明目标会话和希望完成的任务。", 4500)}${memoryChanges.length ? `\n记忆更新：${memoryChanges.join("、")}` : ""}`;
        return { text: this.attachConsoleLink(sessionTitles.render(textContent), linkContext), directory: sessionTitles.rendersDirectory() };
      }
      if (toolCount + answer.toolCalls.length > MAX_TOOL_CALLS) throw new Error("Tool limit exceeded");
      messages.push({ role: "assistant", content: answer.content, tool_calls: answer.toolCalls, responseOutput: answer.responseOutput });
      for (const call of answer.toolCalls) {
        signal.throwIfAborted();
        toolCount++;
        trace.toolCalls = toolCount;
        trace.lastTool = Object.hasOwn(ToolArguments, call.function.name) ? call.function.name : "unsupported";
        if (this.background && BACKGROUND_TOOL_NAMES.has(call.function.name)) {
          trace.lastTool = call.function.name;
          const mutating = call.function.name === "follow_up_background_task" || call.function.name === "extend_background_task";
          if (mutating && !backgroundAuthorization) backgroundAuthorization = classifyBackgroundAuthorization(this.model, sanitizedUserPrompt, signal);
          if (mutating) backgroundAuthority.operations = await backgroundAuthorization!;
          const required = call.function.name === "follow_up_background_task" ? "follow_up" : "extend";
          if (mutating && !backgroundAuthority.operations.has(required) && !backgroundTurn.mutations.length && !automationTurn.attempted) {
            return { text: "当前用户消息没有明确授权该后台追问或延期操作；未执行此操作。" };
          }
          let output: unknown;
          try {
            if (call.function.arguments.length > MAX_BACKGROUND_TOOL_ARGUMENT_CHARS) throw new Error("Background tool arguments exceed budget");
            const raw: unknown = JSON.parse(call.function.arguments);
            // A missing source reader must fail closed while independent background execution remains usable.
            const sourceHub = { getNodeStatusList: () => this.hub.getNodeStatusList(),
              listAutomations: (nodeId: string, readSignal?: AbortSignal) => {
                if (!this.hub.listAutomations) throw new Error("Source automation discovery is unavailable");
                return this.hub.listAutomations(nodeId, readSignal);
              },
              inspectAutomation: (nodeId: string, options: Parameters<NodeHub["inspectAutomation"]>[1], readSignal?: AbortSignal) => {
                if (!this.hub.inspectAutomation) throw new Error("Source automation inspection is unavailable");
                return this.hub.inspectAutomation(nodeId, options, readSignal);
              } };
            output = await executeBackgroundTool(this.background, sourceHub, call.function.name, raw, backgroundAuthority, signal);
          } catch (error) {
            const notice = error instanceof CommandError ? "本轮后台操作授权已失效，未继续提交。"
              : mutating ? "后台操作未取得确认，请核查归属、保留期及本轮明确授权；不自动重试。"
              : "后台任务查询失败，未取得可信记录；请核对发现的任务和精确时间范围。";
            if (mutating && backgroundTurn.mutations.length) backgroundTurn.errors.push(notice);
            output = { error: notice };
          }
          const content = JSON.stringify(output);
          messages.push({ role: "tool", tool_call_id: call.id, content: content.length > 12000
            ? JSON.stringify({ truncated: true, data: clip(content, 12000) }) : content });
          continue;
        }
        if (this.automations && AUTOMATION_TOOL_NAMES.has(call.function.name)) {
          trace.lastTool = call.function.name;
          let raw: unknown;
          try {
            raw = call.function.arguments.length <= MAX_BACKGROUND_TOOL_ARGUMENT_CHARS ? JSON.parse(call.function.arguments) : undefined;
            const backgroundInput = raw !== null && typeof raw === "object" && "kind" in raw && raw.kind === "background";
            if (!backgroundInput && call.function.arguments.length > MAX_STANDARD_TOOL_ARGUMENT_CHARS) raw = undefined;
          }
          catch { raw = undefined; }
          const mutating = call.function.name === "create_automation" || call.function.name === "update_automation";
          const backgroundCreation = call.function.name === "create_automation" && raw !== null && typeof raw === "object" && "kind" in raw && raw.kind === "background";
          const sessionCreation = call.function.name === "create_automation" && raw !== null && typeof raw === "object" && "kind" in raw && raw.kind === "session";
          if (this.background && sessionCreation) {
            if (await currentUserIntent() === "isolated_background") {
              messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error:
                "本轮要求隔离后台执行或读取已有任务结果；不得新建向源会话发送指令的session定时任务。请使用kind=background及已发现的sources。" }) });
              continue;
            }
          }
          const status = raw && typeof raw === "object" && "status" in raw ? raw.status : undefined;
          const required: AutomationOperation | undefined = call.function.name === "create_automation" ? "create"
            : status === "paused" ? "pause" : status === "active" ? "resume" : status === "cancelled" ? "cancel" : undefined;
          if (backgroundCreation && !backgroundAuthorization) backgroundAuthorization = classifyBackgroundAuthorization(this.model, sanitizedUserPrompt, signal);
          if (mutating && !backgroundCreation && !automationAuthorization) automationAuthorization = classifyAutomationAuthorization(this.model, sanitizedUserPrompt, signal);
          const authorized = backgroundCreation ? !!this.background && (await backgroundAuthorization!).has("create")
            : !mutating || required !== undefined && (await automationAuthorization!).has(required);
          let output: unknown;
          if (!authorized) {
            const error = "当前用户消息没有明确授权该定时操作；未执行此操作。";
            if (!automationTurn.attempted) return { text: error };
            automationTurn.errors.push(error);
            output = { error };
          }
          else {
            if (backgroundCreation) {
              try {
                const spec = BackgroundSpecSchema.parse(raw && typeof raw === "object" && "background" in raw ? raw.background : undefined);
                assertBackgroundSourcesDiscovered(backgroundAuthority, spec.sources);
              } catch {
                messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: "后台任务参数或来源未获验证；先发现每台机器上的原生定时任务，再创建监控。" }) });
                continue;
              }
            }
            if (mutating) {
              await assertCurrentAuthority();
              // Once a write may have reached storage, every later failure must
              // report its persisted outcome rather than claiming no task exists.
              automationTurn.attempted = true;
              if (raw && typeof raw === "object" && "id" in raw && typeof raw.id === "string") automationTurn.ids.add(raw.id);
            }
            try {
              output = await executeAutomationTool(this.automations, call.function.name, raw, {
                chatId, currentMessageId: data.inflight!.messageId, explicitCurrentTurnAuthorization: authorized, assertCurrentAuthority,
              }, this.now());
              if (mutating && output && typeof output === "object" && "id" in output && typeof output.id === "string") automationTurn.ids.add(output.id);
              if (mutating && output === null) automationTurn.errors.push("未找到归属于当前聊天的该定时任务，未修改。");
            } catch (error) {
              const notice = error instanceof CommandError ? "本轮操作授权已失效，没有继续提交该定时操作。"
                : mutating ? "定时操作返回异常，需核查持久记录；不自动重建。" : "定时任务查询失败，未取得可信记录。";
              if (mutating) automationTurn.errors.push(notice);
              output = { error: notice };
            }
          }
          const content = JSON.stringify(output);
          messages.push({ role: "tool", tool_call_id: call.id, content: content.length > 12000
            ? JSON.stringify({ truncated: true, data: clip(content, 12000) }) : content });
          continue;
        }
        if ((automationTurn.attempted || backgroundTurn.mutations.length) && ["execute_plan", "execute_goal", "propose_plan", "propose_goal", "send_session_images"].includes(call.function.name)) {
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: "本轮已提交定时操作；即时派发未执行，请先核查定时操作回执。" }) });
          continue;
        }
        if (this.background && ["execute_plan", "execute_goal", "propose_plan", "propose_goal"].includes(call.function.name)) {
          if (await currentUserIntent() === "isolated_background") {
            messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error:
              "用户本轮要求隔离后台执行、跟踪或追问；不得转换为向源会话派发计划或持续目标。新任务请使用create_automation(kind=background)，既有任务请查询后使用后台追问或延期工具。" }) });
            continue;
          }
        }
        if (call.function.name === "send_session_images") {
          let args: unknown;
          try { args = call.function.arguments.length <= 8000 ? JSON.parse(call.function.arguments) : undefined; }
          catch { return { text: "图片目标参数无效，未发送图片。" }; }
          const target = ToolArguments.send_session_images.safeParse(args);
          if (!target.success) return { text: "图片目标参数无效，未发送图片。" };
          if (!await authorizeImageDelivery(this.model, sanitizedUserPrompt, signal)) return { text: "本条消息未明确要求向当前微信聊天发图，未发送图片。" };
          const session = this.hub.getNodeSession(target.data.nodeId, target.data.sessionId);
          if (!this.hub.isNodeConnected(target.data.nodeId) || !session?.capabilities.includes("read") ||
              !this.hub.listMedia || !this.hub.readMedia) return { text: "原会话图片读取能力不可用，未发送图片。" };
          return sendSessionImages(this.hub as Hub & MediaHub, this.store, chatId, data.inflight!.messageId, target.data, signal, this.now);
        }
        if (call.function.name === "execute_plan" || call.function.name === "execute_goal") {
          const intent = await currentUserIntent();
          const requiredIntent = call.function.name === "execute_plan" ? "task" : "goal";
          if (intent !== requiredIntent) return { text: this.attachConsoleLink(
            intent === "query" ? "这条消息只是在查询，没有派发任务。请说明想查看哪个会话的状态或结果。"
              : intent === "preview" ? "按你的要求，暂不执行。请说明需要预览的目标会话和任务。"
              : "本次未派发。请说明目标会话、要完成的任务和执行范围；持续目标还需要明确条件与预算。", linkContext) };
        }
        const priorPlan = data.pending;
        const priorGoal = data.pendingGoal;
        const output = await traceSpan("leader.tool", () => this.callTool(call, chatId, data, memoryChanges, linkContext, signal, sessionTitles),
          { tool: Object.hasOwn(ToolArguments, call.function.name) ? call.function.name : "unsupported" });
        signal.throwIfAborted();
        if (call.function.name === "execute_plan" && data.pending && data.pending !== priorPlan) {
          return { text: "", execution: { plan: data.pending } };
        }
        if (call.function.name === "execute_goal" && data.pendingGoal && data.pendingGoal !== priorGoal) {
          return { text: "", execution: { goal: data.pendingGoal } };
        }
        if (data.pending && data.pending !== priorPlan) return { text: this.attachConsoleLink(this.preview(data.pending), linkContext) };
        if (data.pendingGoal && data.pendingGoal !== priorGoal) return { text: this.attachConsoleLink(goalPreview(data.pendingGoal, node => this.hub.getNodeSkills(node), (node, session) => this.hub.getNodeSession(node, session)?.title), linkContext) };
        const content = JSON.stringify(output);
        messages.push({ role: "tool", tool_call_id: call.id, content: call.function.name !== "list_sessions" && content.length > 12000
          ? JSON.stringify({ truncated: true, data: clip(content, 12000) }) : content });
      }
      if (automationTurn.attempted || backgroundTurn.mutations.length) return this.confirmMutations(chatId, data.inflight!.messageId, automationTurn, backgroundTurn);
    }
    return { text: "本轮查询已达到上限，未向会话发送指令。请缩小目标范围或继续查询。" };
  }

  private attachConsoleLink(content: string, linkContext: LinkContext): string {
    if (!linkContext.issuedLink) return content;
    const notice = `\n\n控制台登录链接（1小时内有效，仅可使用一次，打开后地址栏会自动隐藏登录凭证）：\n${linkContext.issuedLink.url}`;
    return `${content.trim()}${notice}`;
  }

  private async callTool(call: ModelToolCall, chatId: string, data: LeaderData, memoryChanges: string[], linkContext: LinkContext, signal: AbortSignal, sessionTitles: SessionTitles): Promise<unknown> {
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
      case "focus_session_candidates": {
        const { targets } = ToolArguments.focus_session_candidates.parse(raw);
        return sessionTitles.candidates(targets);
      }
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
        const sessions = observed.filter(item => !args.status || item.executionStatus === args.status)
          .sort((a, b) => (Date.parse(b.updatedAt ?? "") || 0) - (Date.parse(a.updatedAt ?? "") || 0));
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
        const listing = sessionTitles.listing({ sessions: sessions.map(item => ({ ...item, nodeName: item.nodeId })), total: sessions.length,
          nextOffset: null,
          snapshot: { scope: "online_observed_sessions", capturedAt: new Date(capturedAt).toISOString(),
            reportedNodeCount: nodes.length, onlineNodeCount: nodes.filter(item => item.connected).length,
            observedNodeCount: new Set(observed.map(item => item.nodeId)).size, observedSessionCount: observed.length,
            statusCounts, unknownStatusCount, notLoadedCount, unknownLoadedCount, missingObservationCount,
            oldestObservedAt: observations[0] ?? null, newestObservedAt: observations.at(-1) ?? null,
            completeTaskCoverage: false,
          } });
        // Keep the full directory on the server; omit previews while preserving raw and selected observations.
        const compact = listing.sessions.map(({ nodeId, id, provider, title, cwd, status, capabilities, loaded,
          executionStatus, statusSource, observedAt, updatedAt, model, modelProvider, reasoningEffort,
          desktopObservation, modelView, sendAvailability, historySource }) => ({
          nodeId, id, provider, title, cwd, status, capabilities, loaded, executionStatus, statusSource,
          observedAt, updatedAt, model, modelProvider, reasoningEffort, desktopObservation,
          modelView, sendAvailability, historySource,
          displayLabel: sessionTitles.add({ nodeId, id, title }),
        }));
        const result = { ...listing, sessions: [] as typeof compact, nextOffset: null as number | null,
          snapshot: { ...listing.snapshot, statusCounts: listing.snapshot.statusCounts as Record<string, number> | undefined,
            statusCountsTruncated: false },
          modelSummary: { truncated: true, omittedSessions: listing.total, skippedOversizedSessions: 0,
            directoryRetainedOnServer: true } };
        if (JSON.stringify(result).length > MAX_SESSION_TOOL_RESULT_CHARS) {
          result.snapshot.statusCounts = undefined;
          result.snapshot.statusCountsTruncated = true;
        }
        let offset = args.offset;
        for (; offset < compact.length; offset++) {
          const nextOffset = offset + 1 < compact.length ? offset + 1 : null;
          const candidate = { ...result, sessions: [...result.sessions, compact[offset]], nextOffset };
          if (JSON.stringify(candidate).length > MAX_SESSION_TOOL_RESULT_CHARS) {
            if (result.sessions.length) break;
            result.modelSummary.skippedOversizedSessions++;
            continue;
          }
          result.sessions.push(compact[offset]);
        }
        result.nextOffset = offset < compact.length ? offset : null;
        result.modelSummary.omittedSessions = listing.total - result.sessions.length;
        result.modelSummary.truncated = result.modelSummary.omittedSessions > 0;
        return result;
      }
      case "read_session": {
        const args = ToolArguments.read_session.parse(raw);
        const history = await readSessionHistory(this.hub, args, signal);
        const session = this.hub.getNodeSession(args.nodeId, args.sessionId);
        return session ? { ...history, displayLabel: sessionTitles.add({ ...session, nodeId: args.nodeId }, true) } : history;
      }
      case "get_command": {
        const { commandId, planId, goalId } = ToolArguments.get_command.parse(raw);
        if (!data.commandIds.includes(commandId)) {
          const execution = planId ? await this.store.getExecution(planId) : await this.store.getLatestExecution(chatId);
          const command = await this.store.getCommand(commandId);
          const executionOwns = !!execution && execution.chatId === chatId && !!command && execution.plan.actions.some((_, index) =>
            execution.attempts[index] && matchesExecutionCommand(execution, index, command));
          if (!executionOwns && !await this.goals.ownsCommand(chatId, commandId, goalId)) {
            sessionTitles.independent();
            return { error: "Command does not belong to this chat" };
          }
        }
        await this.store.markExpiredActiveCommandsUncertain();
        const command = await this.store.getCommand(commandId);
        if (!command) sessionTitles.independent();
        return command ? sessionTitles.focus([command], (node, session) => this.hub.getNodeSession(node, session)?.title)[0] : null;
      }
      case "get_plan_progress": {
        const { planId } = ToolArguments.get_plan_progress.parse(raw);
        const id = planId ?? (await this.store.getLatestExecution(chatId))?.id;
        if (!id) { sessionTitles.independent(); return { plan: null }; }
        const view = await this.executions.view(id, chatId);
        if (!view) sessionTitles.independent();
        return view ? { ...view, steps: sessionTitles.focus(view.steps, (node, session) => this.hub.getNodeSession(node, session)?.title) }
          : { error: "Plan does not belong to this chat" };
      }
      case "get_goal_progress": {
        const { goalId } = ToolArguments.get_goal_progress.parse(raw);
        const view = await this.goals.progress(chatId, goalId);
        if (view && typeof view === "object" && "proposal" in view) {
          const goal = view as Awaited<ReturnType<typeof readGoalView>>;
          return { ...goal, proposal: { ...goal.proposal,
            targets: sessionTitles.focus(goal.proposal.targets, (node, session) => this.hub.getNodeSession(node, session)?.title) } };
        }
        sessionTitles.independent();
        return view;
      }
      case "execute_goal":
      case "propose_goal": {
        const proposal = await this.goals.propose(chatId, ToolArguments.propose_goal.parse(raw));
        if ("error" in proposal) return proposal;
        data.pending = undefined;
        data.pendingGoal = proposal;
        return { pending: true };
      }
      case "execute_plan":
      case "propose_plan": {
        const { actions } = ToolArguments.propose_plan.parse(raw);
        data.pending = undefined;
        try { assertTerminalSingleStep({ actions }); }
        catch { return { error: "终端输入无法证明任务完成，只支持独立单步，不能加入多步或依赖计划" }; }
        try { validatePlanDependencies({ actions }); }
        catch { return { error: "Invalid plan dependencies or result sources; resultFrom must select distinct direct earlier dependencies, and same-session tasks must form a chain" }; }
        const supplement = actions.length === 1 && actions[0].deliveryMode === "steer";
        if (!supplement && (await this.store.getLatestExecution(chatId))?.status === "active") return { error: "An active plan already exists; query its progress or ask the user to cancel it" };
        if (!supplement && await this.goals.hasUnfinished(chatId)) return { error: "An active or blocked goal already exists; query its progress or cancel it" };
        const readiness = hasTerminalTarget({actions}) ? await waitForSendReadiness(this.hub, actions, {
          signal, now: this.now, timeoutMs: data.inflight!.expiresAt - this.now(),
        }) : {ready:true as const,routes:[]};
        if (!readiness.ready) return { error: readinessFailure(readiness) };
        if (data.inflight!.expiresAt <= this.now()) return { error: "等待期间处理授权已过期，未生成计划或派发" };
        const boundActions: Plan["actions"] = [];
        for (const [index, action] of actions.entries()) {
          const session = this.hub.getNodeSession(action.nodeId, action.sessionId) ?? await this.store.getKnownSession(action.nodeId,action.sessionId);
          if (action.skills?.length && this.hub.isNodeConnected(action.nodeId) && !hasSkillRefs(this.hub.getNodeSkills(action.nodeId), action.skills)) {
            return { error: "Selected skill unavailable or changed; query this node's skills first" };
          }
          const route = session ? queueSendRoute(session,readiness.routes[index]) : undefined;
          if (!route) {
            return { error: "Plan contains unavailable, busy or read-only targets; clarify with the user" };
          }
          if (readiness.routes[index] && route !== readiness.routes[index]) {
            return { error: `[${action.nodeId}] ${action.sessionId}：发送路线已变化，请重新生成计划` };
          }
          if (action.deliveryMode === "steer" ? !action.expectedTurnId : action.expectedTurnId !== undefined) return {error:"补充当前轮需要准确expectedTurnId，普通任务不能绑定其他轮次"};
          boundActions.push({ ...action, sendRoute: route });
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
    const labels = sessionLabels(plan.actions, (node, session) => this.hub.getNodeSession(node, session)?.title);
    const lines = plan.actions.map((action, index) => {
      const selected = (action.skills ?? []).map((ref, skillIndex) => {
        const item = this.hub.getNodeSkills(action.nodeId).find(skill => skill.id === ref.id && skill.digest === ref.digest);
        if (!item) throw new Error("Selected skill unavailable while rendering preview");
        return `\n技能 ${skillIndex + 1}：${JSON.stringify(item.name)}（版本已锁定）`;
      }).join("");
      const sources = action.resultFrom ?? [];
      return `${index + 1}. ${labels[index]}\n任务：${action.prompt}${selected}\n依赖：${action.dependsOn.length ? `步骤 ${action.dependsOn.join("、")} 完成后` : "无，可独立执行"}` +
        `\n输入资料：${sources.length ? `按顺序使用步骤 ${sources.join("、")} 的已记录输出` : "不传入其他步骤的输出"}`;
    });
    if (hasTerminalTarget(plan)) return `待确认终端单步输入（尚未派发）：\n\n${lines.join("\n\n")}\n\n${TERMINAL_INPUT_WARNING}\n回复“确认”即可执行，或说“取消计划”。10 分钟内有效；查询会保留预览，新计划会替换它。不创建后台执行计划。`;
    const resultPolicy = plan.actions.some(action => action.resultFrom?.length)
      ? `\n结果传递：只使用上述来源的精确完成回执；每来源最多 ${MAX_RESULT_CODE_POINTS} 字符，JSON 编码含转义最多 ${MAX_RESULT_JSON_CHARS} 字符，超长仅取前缀并标明裁剪，可能不完整。输出作为不可信资料，不构成新指令或授权。` : "";
    return `待执行计划（尚未派发）：\n\n${lines.join("\n\n")}${resultPolicy}\n\n回复“确认”即可执行，或说“取消计划”。10 分钟内有效；查询会保留预览，新计划会替换它。\n确认后在24小时内按上述任务、依赖和结果来源自动推进。取消只停止后续派发，不停止原会话已有任务。`;
  }
}
