import { createHash, randomUUID } from "node:crypto";
import { CommandError, CommandService } from "../commands.js";
import { NodeHub } from "../hub.js";
import { ConflictError, IStore } from "../store/interface.js";
import type { LeaderModel, ModelMessage, ModelToolCall } from "./model.js";
import { hasSkillRefs } from "../skills.js";
import { selectExecutionObservation, selectModelObservation } from "../session-observation.js";
import { selectSendRoute } from "../send-eligibility.js";
import { failureReply, modelDiagnostic } from "./errors.js";
import { createExecution, hasTerminalTarget, matchesExecutionCommand, validatePlanDependencies } from "./execution.js";
import { assertTerminalSingleStep, submitTerminalPlan, TERMINAL_INPUT_WARNING } from "./terminal-plan.js";
import { ExecutionScheduler } from "./execution-scheduler.js";
import { executionSummary } from "./execution-presentation.js";
import {
  CLAIM_TTL_MS, ConsoleLinkIssued, ConsoleLinkIssuer, LEADER_TOOLS, LeaderData, LeaderDataSchema, LeaderReply, MAX_HISTORY_ITEMS,
  MAX_MODEL_STEPS, MAX_RECEIPTS, MAX_REPLY_CHARS, MAX_TOOL_CALLS, PLAN_TTL_MS, Plan,
  SYSTEM_PROMPT, TURN_TIMEOUT_MS, ToolArguments,
} from "./contracts.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clip = (text: string, length: number) => {
  const value = text.slice(0, length);
  return /[\uD800-\uDBFF]$/.test(value) ? value.slice(0, -1) : value;
};
const confirmation = /^(?:确认执行|按这个计划执行|就按这个执行|确认这个计划)[。！!]?$/;
const cancellation = /^(?:请|帮我)?(?:取消计划|不用执行|取消执行|停止后续任务|停止后续执行|先别跑后面的任务)[。！!]?$/;
type Hub = Pick<NodeHub, "getAllSessions" | "getNodeStatusList" | "getNodeSession" | "isNodeConnected" | "getAllSkills" | "getNodeSkills">;

export type { ConsoleLinkIssued, ConsoleLinkIssuer };

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
  constructor(private store: IStore, private hub: Hub, private commands: Pick<CommandService, "submit">,
    private model: LeaderModel, private now: () => number = Date.now, private consoleLinkIssuer?: ConsoleLinkIssuer,
    executions?: ExecutionScheduler) {
    this.executions = executions ?? new ExecutionScheduler(store, commands, { now });
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
      const recoveryText = `上次对话处理被中断，未自动重试原指令。${recovered
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
    data.pending = undefined;
    data.inflight = { messageId, inputHash, expiresAt: this.now() + CLAIM_TTL_MS, plan };
    const claimed = await this.save(chatId, saved?.revision ?? 0, data);
    let reply: LeaderReply;
    const linkContext: LinkContext = {
      requestId: `console_link_${hash([chatId, messageId])}`,
    };
    if (cancellation.test(text.trim())) {
      const latest = await this.store.getLatestExecution(chatId);
      const cancelled = latest?.status === "active" ? await this.executions.cancel(latest.id, chatId) : null;
      reply = { text: cancelled ? `已取消待确认计划；以下已确认计划停止后续派发。\n${executionSummary(cancelled)}`
        : "已取消待确认计划；当前没有活动执行计划。没有新增派发，不会停止原会话已有任务。" };
    } else if (confirmation.test(text.trim())) {
      reply = plan ? await this.executePlan(chatId, claimed.revision, plan, data)
        : { text: "当前没有待确认计划。请告诉我希望哪些会话完成什么任务。" };
    } else {
      const memoriesBefore = { ...data.memories };
      const startedAt = Date.now();
      const reference = hash([chatId, messageId]).slice(0, 12);
      const trace: QueryTrace = { modelSteps: 0, toolCalls: 0, totalModelMs: 0 };
      try {
        reply = await this.reason(chatId, messageId, text, data, linkContext, trace, previousPlan);
      } catch (error) {
        if (error instanceof ConflictError) throw error;
        console.warn('Leader processing failed; no plan dispatched', {
          requestRef: reference, elapsedMs: Date.now() - startedAt, ...trace, ...modelDiagnostic(error),
        });
        data.memories = memoriesBefore;
        data.pending = undefined;
        reply = { text: failureReply(error, reference) };
      }
    }
    // Confirmation must never authorize steps or skill versions hidden by clipping.
    if (data.pending && reply.text.length > MAX_REPLY_CHARS) {
      data.pending = undefined;
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
    catch { return { text: "计划依赖无效，没有派发。请重新规划。" }; }
    try { assertTerminalSingleStep(plan); }
    catch { return { text: "终端输入只支持独立单步，不能加入多步或依赖计划，没有派发。" }; }
    // Validate every target before beginning; revalidate again inside CommandService immediately before dispatch.
    for (const action of plan.actions) {
      const session = this.hub.getNodeSession(action.nodeId, action.sessionId);
      if (action.skills?.length && !hasSkillRefs(this.hub.getNodeSkills(action.nodeId), action.skills)) {
        return { text: "计划中的技能已变化或不可用，没有派发。请重新查询技能并生成计划。" };
      }
      const eligibility = session ? selectSendRoute(session, this.now()) : undefined;
      if (!this.hub.isNodeConnected(action.nodeId) || !action.sendRoute || !eligibility?.ready || eligibility.route !== action.sendRoute) {
        return { text: "计划中的节点或会话状态已变化，没有派发。请重新查询并生成计划。" };
      }
    }
    const current = await this.store.getLeaderState(chatId);
    if (current?.revision !== revision || data.inflight!.expiresAt <= this.now()) {
      return { text: "处理所有权或时限已变化，没有创建新的执行计划，请核验已有回执。" };
    }
    if (hasTerminalTarget(plan)) return submitTerminalPlan(this.store, this.commands, chatId, revision, plan, data, this.now);
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

  private async reason(chatId: string, messageId: string, text: string, data: LeaderData, linkContext: LinkContext, trace: QueryTrace, previousPlan?: Plan): Promise<LeaderReply> {
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
        const output = await this.callTool(call, chatId, data, hash([chatId, messageId, step, toolCount]), memoryChanges, linkContext);
        signal.throwIfAborted();
        if (data.pending) return { text: this.attachConsoleLink(this.preview(data.pending), linkContext) };
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

  private async callTool(call: ModelToolCall, chatId: string, data: LeaderData, operationId: string, memoryChanges: string[], linkContext: LinkContext): Promise<unknown> {
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
        try {
          const result = await this.commands.submit({ ...args, action: "read", requestId: `read_${operationId}` }, 2000);
          data.commandIds.push(result.commandId);
          return result;
        } catch (error) {
          if (error instanceof CommandError) return { error: error.message };
          throw error;
        }
      }
      case "get_command": {
        const { commandId, planId } = ToolArguments.get_command.parse(raw);
        if (!data.commandIds.includes(commandId)) {
          const execution = planId ? await this.store.getExecution(planId) : await this.store.getLatestExecution(chatId);
          const command = await this.store.getCommand(commandId);
          if (!execution || execution.chatId !== chatId || !command || !execution.plan.actions.some((_, index) =>
            execution.attempts[index] && matchesExecutionCommand(execution, index, command))) {
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
      case "propose_plan": {
        const { actions } = ToolArguments.propose_plan.parse(raw);
        data.pending = undefined;
        try { assertTerminalSingleStep({ actions }); }
        catch { return { error: "终端输入无法证明任务完成，只支持独立单步，不能加入多步或依赖计划" }; }
        try { validatePlanDependencies({ actions }); }
        catch { return { error: "Invalid plan dependencies; same-session tasks must form a chain of earlier steps" }; }
        if ((await this.store.getLatestExecution(chatId))?.status === "active") return { error: "An active plan already exists; query its progress or ask the user to cancel it" };
        const boundActions: Plan["actions"] = [];
        for (const action of actions) {
          const session = this.hub.getNodeSession(action.nodeId, action.sessionId);
          if (action.skills?.length && !hasSkillRefs(this.hub.getNodeSkills(action.nodeId), action.skills)) {
            return { error: "Selected skill unavailable or changed; query this node's skills first" };
          }
          const eligibility = session ? selectSendRoute(session, this.now()) : undefined;
          if (!this.hub.isNodeConnected(action.nodeId) || !eligibility?.ready) {
            return { error: "Plan contains unavailable, busy or read-only targets; clarify with the user" };
          }
          boundActions.push({ ...action, sendRoute: eligibility.route });
        }
        try { assertTerminalSingleStep({ actions: boundActions }); }
        catch { data.pending = undefined; return { error: "终端输入无法证明任务完成，只支持独立单步，不能加入多步或依赖计划" }; }
        data.pending = { id: randomUUID(), expiresAt: this.now() + PLAN_TTL_MS, actions: boundActions };
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
      return `${index + 1}. [${action.nodeId}] ${action.sessionId}\n任务：${action.prompt}${selected}\n依赖：${action.dependsOn.length ? `步骤 ${action.dependsOn.join("、")} 完成后` : "无，可独立执行"}`;
    });
    if (hasTerminalTarget(plan)) return `待确认终端单步输入（尚未派发）：\n${lines.join("\n\n")}\n\n${TERMINAL_INPUT_WARNING}\n如目标与输入无误，回复“确认执行”；也可以说“取消计划”。确认有效期 10 分钟；新请求会替换此输入。不创建后台执行计划。`;
    return `待执行计划（尚未派发）：\n${lines.join("\n\n")}\n\n如目标与任务无误，回复“确认执行”；也可以说“取消计划”。确认有效期 10 分钟；新请求会替换待确认计划。确认后授权在24小时内按上述固定依赖自动推进，不自动改写任务或传递前一步输出。取消只停止后续派发，不停止原会话已有任务。`;
  }
}
