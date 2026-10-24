import { createHash } from "node:crypto";
import { z } from "zod";
import { parseSessionDirectoryQuery } from "@super-leader/wechat-text";
import { CommandError } from "../commands/service.js";
import { type IStore } from "../store/interface.js";
import type { LeaderState } from "./state.js";
import type { ModelToolCall } from "./model/contracts.js";
import { AUTOMATION_ARGUMENTS, AUTOMATION_TOOLS, AUTOMATION_TOOL_NAMES, executeAutomationTool } from "../automations/tools.js";
import type { AutomationService } from "../automations/service.js";
import { BackgroundSpecSchema } from "../background/contracts.js";
import { BACKGROUND_ARGUMENTS, BACKGROUND_TOOLS, BACKGROUND_TOOL_NAMES, assertBackgroundSourcesDiscovered,
  executeBackgroundTool, type BackgroundToolService, type BackgroundToolAuthority } from "./background-tools.js";
import { CLAIM_TTL_MS, LEADER_TOOLS, LeaderDataSchema, TURN_TIMEOUT_MS, type LeaderData,
  MAX_REPLY_CHARS, ToolArguments, type LeaderReply, type Plan, type ConsoleLinkIssued } from "./contracts.js";
import type { GoalProposal } from "./goals/goal.js";
import { goalPreview } from "./goals/presentation.js";
import type { GoalConversation } from "./goals/conversation.js";
import type { ExecutionScheduler } from "./plans/scheduler.js";
import { recoverSteerPlanCommand } from "./plans/steer.js";
import { retainLeaderData } from "./persistence.js";
import { SessionTitles } from "./queries/session-titles.js";
import { sendSessionImages } from "./queries/session-images.js";
import type { MediaHub } from "../sessions/message-images.js";
import type { Hub } from "./orchestrator.js";
import { DirectToolRejectedError } from "./direct-errors.js";
import { DirectToolJournal } from "./direct-journal.js";
import { DIRECT_TOOL_INSTRUCTIONS, DirectAuthorizationSchema,
  type DirectCall, type DirectRequest, type DirectToolResult } from "./direct-contracts.js";
import { goalConfirmation } from "./goals/conversation.js";
import { traceSpan } from "../runtime/telemetry.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sanitize = (text: string) => text.replace(/#login=[A-Za-z0-9_.~%-]+/g, "#login=[REDACTED]");
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
const EMPTY = { type: "object", properties: {}, additionalProperties: false };
const EXPLICIT_CONFIRM = /^(?:请)?(?:确认|执行|开始|开始执行|确认执行|确认开始|按这个计划执行|就按这个执行|确认这个计划)[。！!]?$/;
const CONFIRM = /^(?:请)?(?:确认|执行|开始|开始执行|确认执行|确认开始|按这个计划执行|就按这个执行|确认这个计划|是|是的|对|对的|没错|好的|好|可以|就这样|就这个|就是这个|就是它|嗯|嗯嗯)[。！!]?$/;
const EXTRA_TOOLS = [
  { name: "confirm_pending", description: "Consume the real current user's confirmation of the uniquely displayed, unexpired plan or goal; never confirms the agent's own preview." },
  { name: "cancel_plan", description: "Cancel pending or future fixed-plan steps when explicitly requested; does not stop an already running source task." },
  { name: "cancel_goal", description: "Cancel this chat's pending or active goal when explicitly requested; does not stop source tasks already running." },
];
interface LinkContext { requestId: string; cachedLinkPromise?: Promise<ConsoleLinkIssued>; issuedLink?: ConsoleLinkIssued }
interface Options {
  store: IStore; hub: Hub; now: () => number; isAllowed: (chatId: string) => boolean;
  automations?: AutomationService; background?: BackgroundToolService; goalsAvailable: boolean;
  goals: GoalConversation; executions: ExecutionScheduler;
  save: (chatId: string, revision: number, data: LeaderData) => Promise<LeaderState>;
  callTool: (call: ModelToolCall, chatId: string, data: LeaderData, changes: string[], link: LinkContext,
    signal: AbortSignal, titles: SessionTitles) => Promise<unknown>;
  executePlan: (chatId: string, revision: number, plan: Plan, data: LeaderData) => Promise<LeaderReply>;
  confirmGoal: (chatId: string, revision: number, goal: GoalProposal, data: LeaderData) => Promise<LeaderReply>;
  preview: (plan: Plan) => string;
}

/** The outer Codex decides semantics; this executor retains deterministic business authority. */
export class DirectToolExecutor {
  private journal: DirectToolJournal;
  private chats = new Set<string>();
  constructor(private readonly options: Options) {
    this.journal = new DirectToolJournal(options.store, options.isAllowed);
  }

  async list(request: DirectRequest) {
    await this.journal.bind(request);
    const state = await this.context(request);
    const tools = [...LEADER_TOOLS.filter(tool => this.options.goalsAvailable || !["execute_goal", "propose_goal"].includes(tool.function.name)), ...(this.options.automations ? AUTOMATION_TOOLS : []),
      ...(this.options.background ? BACKGROUND_TOOLS : [])].map(tool => ({ name: tool.function.name,
      description: tool.function.description, inputSchema: this.wrapper(tool.function.parameters),
      annotations: { readOnlyHint: this.isReadOnly(tool.function.name) } }));
    tools.push(...EXTRA_TOOLS.map(tool => ({ ...tool, inputSchema: this.wrapper(EMPTY), annotations: { readOnlyHint: false } })));
    return { tools, instructions: DIRECT_TOOL_INSTRUCTIONS,
      context: { history: state.history.map(item => ({ ...item, content: sanitize(item.content) })), memories: state.memories,
        pending: state.pending ?? null, pendingGoal: state.pendingGoal ?? null } };
  }

  private wrapper(schema: unknown) {
    return { type: "object", properties: { arguments: schema,
      authorization: z.toJSONSchema(DirectAuthorizationSchema, { io: "input" }) },
      required: ["arguments"], additionalProperties: false };
  }

  private isReadOnly(name: string) {
    return !["execute_plan", "execute_goal", "propose_plan", "propose_goal", "remember", "forget", "get_console_link",
      "confirm_pending", "cancel_plan", "cancel_goal", "send_session_images", "create_automation", "update_automation", "follow_up_background_task", "extend_background_task"].includes(name);
  }

  async call(request: DirectCall): Promise<DirectToolResult> {
    this.validate(request);
    await this.journal.bind(request);
    await this.context(request);
    if (this.isReadOnly(request.name)) return this.journal.call(request, () => this.read(request));
    const effect = ["execute_plan", "execute_goal", "confirm_pending"].includes(request.name)
      ? "dispatch" : ["propose_plan", "propose_goal"].includes(request.name) ? "preview" : request.name === "send_session_images" ? "images" : `${request.name}:${JSON.stringify(canonical(request.arguments))}`;
    return this.journal.call(request, async () => {
      if (this.chats.has(request.chatId)) throw new CommandError(409, "Another direct tool is active for this chat");
      this.chats.add(request.chatId);
      try { return await this.run(request); }
      finally { this.chats.delete(request.chatId); }
    }, effect);
  }

  private validate(request: DirectCall) {
    const schemas = { ...ToolArguments, ...AUTOMATION_ARGUMENTS, ...BACKGROUND_ARGUMENTS,
      confirm_pending: z.object({}).strict(), cancel_plan: z.object({}).strict(), cancel_goal: z.object({}).strict() };
    const schema = schemas[request.name as keyof typeof schemas];
    if (!schema) throw new DirectToolRejectedError(400, "Unknown business tool");
    const parsed = schema.safeParse(request.arguments);
    if (!parsed.success) throw new DirectToolRejectedError(400, "Invalid business tool arguments");
    if (!this.options.goalsAvailable && ["execute_goal", "propose_goal"].includes(request.name)) throw new DirectToolRejectedError(503, "Goal execution model unavailable");
    if (AUTOMATION_TOOL_NAMES.has(request.name) && !this.options.automations || BACKGROUND_TOOL_NAMES.has(request.name) && !this.options.background) {
      throw new DirectToolRejectedError(503, "Business tool unavailable");
    }
    this.checkAuthorization(request);
  }

  private async context(request: DirectRequest): Promise<LeaderData> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const saved = await this.options.store.getLeaderState(request.chatId);
      const data = LeaderDataSchema.parse(saved?.data ?? {}), inputHash = hash(request.text);
      const expiredSteer = data.inflight && data.inflight.expiresAt <= this.options.now() &&
        data.inflight.plan?.actions.length === 1 && data.inflight.plan.actions[0].deliveryMode === "steer";
      if (!expiredSteer && data.directContext?.messageId === request.messageId && data.directContext.inputHash === inputHash && data.directContext.expiresAt > this.options.now()) return data;
      if (data.inflight && data.inflight.expiresAt > this.options.now()) throw new CommandError(409, "Previous chat request is still active");
      if (expiredSteer) {
        await this.recoverSteerReceipt(request.chatId, data);
        data.inflight = undefined;
      }
      if (data.directPreview && data.directPreview.messageId !== request.messageId && !data.directPreview.followupMessageId) data.directPreview.followupMessageId = request.messageId;
      data.directContext = { messageId: request.messageId, inputHash, expiresAt: this.options.now() + CLAIM_TTL_MS,
        discoveredRunIds: [], discoveredSources: {}, discoveredSessions: [] };
      retainLeaderData(data);
      const next = await this.options.store.compareAndSetLeaderState(request.chatId, saved?.revision ?? 0, data);
      if (next) return LeaderDataSchema.parse(next.data);
    }
    throw new CommandError(409, "Chat context changed repeatedly; retry discovery");
  }

  private async recoverSteerReceipt(chatId: string, data: LeaderData): Promise<void> {
    const prior = data.inflight;
    if (!prior?.plan) return;
    const command = await recoverSteerPlanCommand(this.options.store, chatId, prior.plan);
    if (!command) return;
    data.commandIds.push(command.commandId);
    if (data.pending?.id === prior.plan.id) data.pending = undefined;
    if (!data.receipts.some(receipt => receipt.messageId === prior.messageId)) {
      data.receipts.push({ messageId: prior.messageId, inputHash: prior.inputHash, commandId: command.commandId,
        text: `已找回本次当前轮补充的持久指令：${command.commandId}（状态：${command.status}）。补充执行情况仍需核查，不会重复发送。` });
    }
  }

  private titles(data: LeaderData): SessionTitles {
    const titles = new SessionTitles();
    if (data.directContext?.discoveredSessions.length) titles.listing({ sessions: data.directContext.discoveredSessions });
    return titles;
  }

  private renderResult(value: unknown, titles: SessionTitles): unknown {
    if (typeof value === "string") return titles.renderReferences(value);
    if (Array.isArray(value)) return value.map(item => this.renderResult(item, titles));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.renderResult(item, titles)]));
    return value;
  }

  private sourceHub() {
    const hub = this.options.hub;
    return { getNodeStatusList: () => hub.getNodeStatusList(),
      listAutomations: (node: string, signal?: AbortSignal) => {
        if (!hub.listAutomations) throw new CommandError(503, "Source discovery unavailable");
        return hub.listAutomations(node, signal);
      }, inspectAutomation: (node: string, args: Parameters<NonNullable<Hub["inspectAutomation"]>>[1], signal?: AbortSignal) => {
        if (!hub.inspectAutomation) throw new CommandError(503, "Source inspection unavailable");
        return hub.inspectAutomation(node, args, signal);
      } };
  }

  private async read(request: DirectCall): Promise<DirectToolResult> {
    const o = this.options, data = await this.context(request), titles = this.titles(data);
    const discovery = data.directContext!;
    const authority: BackgroundToolAuthority = { chatId: request.chatId, currentMessageId: request.messageId,
      operations: new Set(), discoveredRunIds: new Set(discovery.discoveredRunIds),
      discoveredSources: new Map(Object.entries(discovery.discoveredSources).map(([node, ids]) => [node, new Set(ids)])) };
    const signal = AbortSignal.timeout(TURN_TIMEOUT_MS);
    const result = await traceSpan("leader.tool", async () => {
      if (BACKGROUND_TOOL_NAMES.has(request.name)) return executeBackgroundTool(o.background!, this.sourceHub(), request.name, request.arguments, authority, signal);
      if (AUTOMATION_TOOL_NAMES.has(request.name)) return executeAutomationTool(o.automations!, request.name, request.arguments,
        { chatId: request.chatId, currentMessageId: request.messageId, explicitCurrentTurnAuthorization: false }, o.now());
      return o.callTool({ id: request.callId, type: "function", function: { name: request.name, arguments: JSON.stringify(request.arguments) } },
        request.chatId, data, [], { requestId: "readonly" }, signal, titles);
    }, { tool: request.name, source: "direct" });
    signal.throwIfAborted();
    if (["list_source_automations", "list_background_tasks", "list_sessions"].includes(request.name)) {
      const sessions = request.name === "list_sessions" ? titles.snapshot().map(({ nodeId, id, title }) => ({ nodeId, id, ...(title ? { title } : {}) })) : [];
      let merged = false;
      for (let attempt = 0; attempt < 8; attempt++) {
        const saved = await o.store.getLeaderState(request.chatId), latest = LeaderDataSchema.parse(saved?.data ?? {}), context = latest.directContext;
        if (!context || context.messageId !== request.messageId || context.inputHash !== hash(request.text) || context.expiresAt <= o.now() || latest.inflight) throw new CommandError(409, "Discovery authority changed; repeat discovery");
        context.discoveredRunIds = [...new Set([...context.discoveredRunIds, ...authority.discoveredRunIds])];
        for (const [node, ids] of authority.discoveredSources) context.discoveredSources[node] = [...new Set([...(context.discoveredSources[node] ?? []), ...ids])];
        context.discoveredSessions = [...new Map([...context.discoveredSessions, ...sessions].map(item => [JSON.stringify([item.nodeId, item.id]), item])).values()];
        LeaderDataSchema.parse(latest);
        if (await o.store.compareAndSetLeaderState(request.chatId, saved?.revision ?? 0, latest)) { merged = true; break; }
      }
      if (!merged) throw new CommandError(409, "Discovery metadata changed repeatedly");
    }
    const reply = request.name === "list_sessions" && parseSessionDirectoryQuery(request.text) ? { text: titles.render("") } : undefined;
    if (reply) await o.store.recordMessage({ chatId: request.chatId, messageId: request.messageId, text: request.text, replyText: reply.text, createdAt: new Date().toISOString() });
    return { result: this.renderResult(result, titles), ...(reply ? { reply } : {}) };
  }

  private async run(request: DirectCall): Promise<DirectToolResult> {
    const o = this.options, { chatId, messageId, name, authorization: auth } = request;
    const saved = await o.store.getLeaderState(chatId);
    const data = LeaderDataSchema.parse(saved?.data ?? {});
    if (data.inflight && data.inflight.expiresAt > o.now()) throw new CommandError(409, "Previous chat request is still active");
    await this.recoverSteerReceipt(chatId, data);
    const inputHash = hash(request.text);
    const priorPlan = data.pending, priorGoal = data.pendingGoal;
    // Revoke queued supplements in the same durable claim as the cancellation.
    if (name === "cancel_plan" || name === "cancel_goal") data.steerGeneration++;
    data.inflight = { messageId, inputHash, expiresAt: o.now() + CLAIM_TTL_MS };
    if (!data.directContext || data.directContext.messageId !== messageId || data.directContext.inputHash !== inputHash || data.directContext.expiresAt <= o.now()) {
      data.directContext = { messageId, inputHash, expiresAt: o.now() + CLAIM_TTL_MS, discoveredRunIds: [], discoveredSources: {}, discoveredSessions: [] };
    }
    let claimed = await o.save(chatId, saved?.revision ?? 0, data);
    const assertAuthority = async () => {
      if (!o.isAllowed(chatId)) throw new CommandError(403, "CHAT_NOT_ALLOWED");
      const current = await o.store.getLeaderState(chatId);
      const claim = current && LeaderDataSchema.parse(current.data).inflight;
      if (current?.revision !== claimed.revision || claim?.messageId !== messageId || claim?.inputHash !== inputHash || claim.expiresAt <= o.now()) {
        throw new CommandError(409, "Direct tool authority changed or expired");
      }
    };
    const authority: BackgroundToolAuthority = { chatId, currentMessageId: messageId, operations: new Set(auth.backgroundOperations),
      discoveredRunIds: new Set(data.directContext.discoveredRunIds),
      discoveredSources: new Map(Object.entries(data.directContext.discoveredSources).map(([node, ids]) => [node, new Set(ids)])),
      assertCurrentAuthority: assertAuthority };
    const link: LinkContext = { requestId: `console_link_${hash([chatId, messageId])}` };
    const titles = this.titles(data);
    const signal = AbortSignal.timeout(TURN_TIMEOUT_MS);
    let result: unknown, reply: LeaderReply | undefined;
    try {
      this.checkAuthorization(request);
      if (BACKGROUND_TOOL_NAMES.has(name)) {
        if (!o.background) throw new CommandError(503, "Background tools unavailable");
        result = await traceSpan("leader.tool", () => executeBackgroundTool(o.background!, this.sourceHub(), name, request.arguments, authority, signal), { tool: name, source: "direct" });
      } else if (AUTOMATION_TOOL_NAMES.has(name)) {
        if (!o.automations) throw new CommandError(503, "Automation tools unavailable");
        const raw = request.arguments;
        const background = raw !== null && typeof raw === "object" && "kind" in raw && raw.kind === "background";
        if (name === "create_automation" && background) {
          const spec = BackgroundSpecSchema.parse("background" in raw ? raw.background : undefined);
          assertBackgroundSourcesDiscovered(authority, spec.sources);
        }
        await assertAuthority();
        result = await traceSpan("leader.tool", () => executeAutomationTool(o.automations!, name, raw, {
          chatId, currentMessageId: messageId, explicitCurrentTurnAuthorization: true, assertCurrentAuthority: assertAuthority,
        }, o.now()), { tool: name, source: "direct" });
      } else if (name === "confirm_pending") {
        z.object({}).strict().parse(request.arguments);
        const text = request.text.trim(), explicitGoal = goalConfirmation(text);
        const preview = data.directPreview;
        const displayed = preview?.id ?? data.history.at(-1)?.confirmationFor;
        const unique = !!priorPlan !== !!priorGoal;
        const explicit = EXPLICIT_CONFIRM.test(text);
        const natural = CONFIRM.test(text) && displayed === (priorPlan?.id ?? priorGoal?.id) &&
          (!preview || preview.followupMessageId === messageId);
        const selectedGoal = explicitGoal ? priorGoal?.id === explicitGoal : unique && !priorPlan;
        if (preview?.messageId === messageId || !(explicitGoal ? selectedGoal : unique && (explicit || natural))) {
          throw new CommandError(409, "No unique prior preview confirmed by the real current user");
        }
        if (priorPlan && !explicitGoal) {
          data.inflight.plan = priorPlan; data.pending = undefined;
          claimed = await o.save(chatId, claimed.revision, data);
          reply = await o.executePlan(chatId, claimed.revision, priorPlan, data);
        } else {
          if (!o.goalsAvailable) throw new CommandError(503, "Goal execution model unavailable");
          data.inflight.goal = priorGoal!; data.pendingGoal = undefined;
          claimed = await o.save(chatId, claimed.revision, data);
          reply = await o.confirmGoal(chatId, claimed.revision, priorGoal!, data);
        }
        result = reply;
      } else if (name === "cancel_goal" || name === "cancel_plan") {
        z.object({}).strict().parse(request.arguments);
        await assertAuthority();
        if (name === "cancel_goal") { data.pendingGoal = undefined; reply = await o.goals.cancel(chatId); }
        else {
          data.pending = undefined;
          const latest = await o.store.getLatestExecution(chatId);
          const view = latest?.status === "active" ? await o.executions.cancel(latest.id, chatId) : null;
          reply = { text: view ? "已取消计划后续派发，原会话当前执行未停止。" : "已取消待确认计划；没有活动计划。" };
        }
        result = reply;
      } else if (name === "send_session_images") {
        const target = ToolArguments.send_session_images.parse(request.arguments);
        if (!o.hub.listMedia || !o.hub.readMedia) throw new CommandError(503, "Image tools unavailable");
        const session = o.hub.getNodeSession(target.nodeId, target.sessionId);
        if (!o.hub.isNodeConnected(target.nodeId) || !session?.capabilities.includes("read")) throw new CommandError(403, "Image source unavailable");
        reply = await sendSessionImages(o.hub as Hub & MediaHub, o.store, chatId, messageId, target, signal, o.now);
        result = reply;
      } else {
        result = await traceSpan("leader.tool", () => o.callTool({ id: request.callId, type: "function",
          function: { name, arguments: JSON.stringify(request.arguments) } }, chatId, data, [], link, signal, titles), { tool: name, source: "direct" });
        if (name === "execute_plan" && data.pending && data.pending !== priorPlan) {
          const plan = data.pending; data.pending = undefined; data.inflight.plan = plan;
          claimed = await o.save(chatId, claimed.revision, data);
          reply = await o.executePlan(chatId, claimed.revision, plan, data); result = reply;
        } else if (name === "execute_goal" && data.pendingGoal && data.pendingGoal !== priorGoal) {
          const goal = data.pendingGoal; data.pendingGoal = undefined; data.inflight.goal = goal;
          claimed = await o.save(chatId, claimed.revision, data);
          reply = await o.confirmGoal(chatId, claimed.revision, goal, data); result = reply;
        } else if (name === "propose_plan" && data.pending && data.pending !== priorPlan) {
          reply = { text: o.preview(data.pending) }; result = reply;
        } else if (name === "propose_goal" && data.pendingGoal && data.pendingGoal !== priorGoal) {
          reply = { text: goalPreview(data.pendingGoal, node => o.hub.getNodeSkills(node), (node, session) => o.hub.getNodeSession(node, session)?.title) }; result = reply;
        } else if (name === "list_sessions" && parseSessionDirectoryQuery(request.text)) {
          reply = { text: titles.render("") };
        } else if (name === "get_console_link" && link.issuedLink) {
          reply = { text: `控制台登录链接（1小时内有效，仅可使用一次）：\n${link.issuedLink.url}` };
        }
      }
      signal.throwIfAborted();
      result = this.renderResult(result, titles);
      const proposed = name === "propose_plan" || name === "propose_goal";
      if (proposed && reply && reply.text.length > MAX_REPLY_CHARS) {
        data.pending = undefined; data.pendingGoal = undefined; data.directPreview = undefined;
        reply = { text: "计划内容过长，无法完整展示供确认，未保存待确认计划，也未派发。请缩短任务内容或分批提出。" };
        result = reply;
      }
      data.directContext.discoveredRunIds = [...authority.discoveredRunIds];
      data.directContext.discoveredSources = Object.fromEntries([...authority.discoveredSources].map(([node, ids]) => [node, [...ids]]));
      if (reply) {
        const confirmationFor = data.pending && data.pending !== priorPlan ? data.pending.id
          : data.pendingGoal && data.pendingGoal !== priorGoal ? data.pendingGoal.id : undefined;
        if (confirmationFor) data.directPreview = { id: confirmationFor, messageId };
        data.history.push({ role: "user", content: sanitize(request.text), complete: true }, { role: "assistant",
          content: name === "get_console_link" ? "控制台登录链接已生成。" : sanitize(reply.text), complete: true,
          ...(confirmationFor ? { confirmationFor } : {}) });
      }
      data.inflight = undefined;
      await o.save(chatId, claimed.revision, data);
      if (reply && (name === "list_sessions" && parseSessionDirectoryQuery(request.text) || name === "get_console_link")) {
        await o.store.recordMessage({ chatId, messageId, text: request.text, replyText: reply.text,
          ...(reply.images ? { images: reply.images } : {}), createdAt: new Date().toISOString() });
      }
      return { result, ...(reply ? { reply } : {}) };
    } catch (error) {
      // Clear only this still-owned lease. The durable call start remains uncertain.
      const current = await o.store.getLeaderState(chatId);
      if (current?.revision === claimed.revision) {
        const latest = LeaderDataSchema.parse(current.data);
        await this.recoverSteerReceipt(chatId, latest);
        latest.inflight = undefined;
        await o.save(chatId, current.revision, latest);
      }
      throw error;
    }
  }

  private checkAuthorization(request: DirectCall) {
    const { name, authorization: auth } = request;
    const require = (allowed: boolean) => { if (!allowed) throw new DirectToolRejectedError(403, "Current-turn authorization does not permit this operation"); };
    if (["execute_plan", "cancel_plan", "cancel_goal"].includes(name)) require(auth.intent === "task");
    if (name === "execute_goal") require(auth.intent === "goal");
    if (["propose_plan", "propose_goal"].includes(name)) require(auth.intent === "preview");
    if (name === "send_session_images") require(auth.sendImages);
    if (name === "remember" || name === "forget") require(auth.memoryOperations.includes(name));
    if (name === "follow_up_background_task") require(auth.backgroundOperations.includes("follow_up"));
    if (name === "extend_background_task") require(auth.backgroundOperations.includes("extend"));
    if (name === "create_automation") {
      const args = request.arguments;
      const kind = args !== null && typeof args === "object" && "kind" in args ? args.kind : undefined;
      require(kind === "background" ? auth.backgroundOperations.includes("create") : auth.automationOperations.includes("create"));
      if (kind === "session") require(auth.intent !== "isolated_background");
    }
    if (name === "update_automation") {
      const args = request.arguments;
      const status = args !== null && typeof args === "object" && "status" in args ? args.status : undefined;
      const operation = status === "paused" ? "pause" : status === "active" ? "resume" : status === "cancelled" ? "cancel" : undefined;
      require(operation !== undefined && auth.automationOperations.includes(operation));
    }
  }
}
