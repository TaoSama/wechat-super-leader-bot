import { createHash } from "node:crypto";
import { z } from "zod";
import { parseSessionDirectoryQuery } from "@super-leader/wechat-text";
import { CommandError } from "../commands/service.js";
import { type IStore } from "../store/interface.js";
import type { LeaderState } from "./state.js";
import type { LeaderModel, ModelToolCall } from "./model/contracts.js";
import { assertBackgroundExecutorAuthorized, BackgroundExecutorAuthorizationError } from "./model/background-executor-authorization.js";
import { AUTOMATION_ARGUMENTS, AUTOMATION_TOOLS, AUTOMATION_TOOL_NAMES, executeAutomationTool } from "../automations/tools.js";
import type { AutomationService } from "../automations/service.js";
import { BackgroundSpecSchema } from "../background/contracts.js";
import { BACKGROUND_ARGUMENTS, BACKGROUND_TOOLS, BACKGROUND_TOOL_NAMES, assertBackgroundSourcesDiscovered,
  executeBackgroundTool, type BackgroundToolService, type BackgroundToolAuthority } from "./background-tools.js";
import type { BackgroundOperation } from "./model/background-authorization.js";
import { CLAIM_TTL_MS, LEADER_TOOLS, LeaderDataSchema, TURN_TIMEOUT_MS, type LeaderData,
  MAX_REPLY_CHARS, ToolArguments, type LeaderReply, type Plan, type ConsoleLinkIssued } from "./contracts.js";
import type { GoalProposal } from "./goals/goal.js";
import { goalPreview } from "./goals/presentation.js";
import type { GoalConversation } from "./goals/conversation.js";
import type { ExecutionScheduler } from "./plans/scheduler.js";
import { recoverSteerPlanCommand } from "./plans/steer.js";
import { ambiguousCancellationText, cancelActivePlan } from "./plans/active.js";
import { retainLeaderData } from "./persistence.js";
import { SessionTitles } from "./queries/session-titles.js";
import { sendSessionImages } from "./queries/session-images.js";
import type { MediaHub } from "../sessions/message-images.js";
import type { Hub } from "./orchestrator.js";
import { DirectToolRejectedError, chatBusy, chatBusyAfterStart, discoveryChanged, goalsUnavailable, invalidArguments } from "./direct-errors.js";
import { approvalAuthorizationFailure } from "./session-approval.js";
import { DirectToolJournal } from "./direct-journal.js";
import { CancelPlanArgumentsSchema, DIRECT_TOOL_INSTRUCTIONS,
  type DirectCall, type DirectRequest, type DirectToolResult } from "./direct-contracts.js";
import { goalConfirmation } from "./goals/conversation.js";
import { traceSpan } from "../runtime/telemetry.js";
import type { LocalSettingsService, LocalRuntimeSettings } from "../settings/local-service.js";
import { DIRECT_EXTRA_TOOLS } from "../settings/local-registry.js";
import { recentAttachmentContext } from "../sessions/inbound-attachments.js";
import { consoleLinkRequestId, redactConsoleLinkSecrets as sanitize, redactIssuedConsoleLink, restoreConsoleLinkReply, type ConsoleLinkResolver, type ConsoleLinkRedactor } from "../console/link-reply.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
const EXPLICIT_CONFIRM = /^(?:请)?(?:确认|执行|开始|开始执行|确认执行|确认开始|按这个计划执行|就按这个执行|确认这个计划)[。！!]?$/;
const CONFIRM = /^(?:请)?(?:确认|执行|开始|开始执行|确认执行|确认开始|按这个计划执行|就按这个执行|确认这个计划|是|是的|对|对的|没错|好的|好|可以|就这样|就这个|就是这个|就是它|嗯|嗯嗯)[。！!]?$/;

/** Calling one of these tools is itself the request for the background operation it performs. */
const BACKGROUND_OPERATION_BY_TOOL: Partial<Record<string, BackgroundOperation>> = {
  follow_up_background_task: "follow_up", extend_background_task: "extend",
};

/** Monitoring sources and isolated background work exist only on kind=background schedules. */
function assertAutomationKind(args: unknown) {
  if (args === null || typeof args !== "object" || !("kind" in args) || args.kind === "background") return;
  const background = "background" in args ? args.background : undefined;
  const sources = background !== null && typeof background === "object" && "sources" in background ? background.sources : undefined;
  if (background !== undefined || "sources" in args || Array.isArray(sources) && sources.length) {
    throw new DirectToolRejectedError(400, "AUTOMATION_KIND_MISMATCH",
      "监控其他定时任务或隔离后台任务必须用 kind=background。改成 kind=background 并把配置放进 background 后再调用。");
  }
}

interface LinkContext { requestId: string; cachedLinkPromise?: Promise<ConsoleLinkIssued>; issuedLink?: ConsoleLinkIssued }
interface Options {
  backgroundExecutorAuthorizationModel: LeaderModel;
  consoleLinkResolver?: ConsoleLinkResolver;
  consoleLinkRedactor?: ConsoleLinkRedactor;
  settings?: LocalSettingsService;
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
    this.journal = new DirectToolJournal(options.store, options.isAllowed, async (request, result) => {
      const serialized = JSON.stringify(result);
      return request.name === "get_console_link" && options.consoleLinkRedactor
        ? options.consoleLinkRedactor(consoleLinkRequestId(request.chatId, request.messageId), serialized) : serialized;
    });
  }

  async list(request: DirectRequest) {
    await this.journal.bind(request);
    const state = await this.context(request);
    const settings = await this.settingsView(request);
    const tools = [...LEADER_TOOLS.filter(tool => this.options.goalsAvailable || !["execute_goal", "propose_goal"].includes(tool.function.name)), ...(this.options.automations ? AUTOMATION_TOOLS : []),
      ...(this.options.background ? BACKGROUND_TOOLS : []), ...DIRECT_EXTRA_TOOLS].map(base => settings?.tool(base) ?? base).map(tool => ({ name: tool.function.name,
      description: tool.function.description, inputSchema: this.wrapper(tool.function.parameters),
      annotations: { readOnlyHint: this.isReadOnly(tool.function.name) } }));
    return { tools, instructions: settings?.prompt("direct") ?? DIRECT_TOOL_INSTRUCTIONS,
      context: { history: state.history.map(item => ({ ...item, content: sanitize(item.content) })), memories: state.memories,
        pending: state.pending ?? null, pendingGoal: state.pendingGoal ?? null,
        ...await this.attachmentContext(request.chatId) } };
  }

  private async attachmentContext(chatId: string) {
    const attachments = await recentAttachmentContext(this.options.store, chatId, this.options.now());
    return attachments.length ? { attachments } : {};
  }

  private wrapper(schema: unknown) {
    return { type: "object", properties: { arguments: schema }, required: ["arguments"], additionalProperties: false };
  }

  private isReadOnly(name: string) {
    return !["execute_plan", "execute_goal", "propose_plan", "propose_goal", "remember", "forget", "get_console_link",
      "confirm_pending", "cancel_plan", "cancel_goal", "send_session_images", "interrupt_session", "answer_approval", "create_automation", "update_automation", "follow_up_background_task", "extend_background_task"].includes(name);
  }

  async call(request: DirectCall): Promise<DirectToolResult> {
    this.validate(request);
    await this.journal.bind(request);
    await this.context(request);
    const settings = await this.settingsView(request);
    const base = [...LEADER_TOOLS, ...AUTOMATION_TOOLS, ...BACKGROUND_TOOLS, ...DIRECT_EXTRA_TOOLS].find(tool => tool.function.name === request.name);
    if (base && settings) {
      try { settings.assertArguments(base, request.arguments); }
      catch { throw invalidArguments(); }
    }
    if (this.isReadOnly(request.name)) return this.journal.call(request, () => this.read(request));
    const effect = ["execute_plan", "execute_goal", "confirm_pending"].includes(request.name)
      ? "dispatch" : ["propose_plan", "propose_goal"].includes(request.name) ? "preview" : request.name === "send_session_images" ? "images" : `${request.name}:${JSON.stringify(canonical(request.arguments))}`;
    const result = await this.journal.call(request, async () => {
      // Runs inside the journal action, after its start markers; see chatBusyAfterStart.
      if (this.chats.has(request.chatId)) throw chatBusyAfterStart();
      this.chats.add(request.chatId);
      try { return await this.run(request); }
      finally { this.chats.delete(request.chatId); }
    }, effect);
    if (result.reply) return { ...result, reply: { ...result.reply,
      text: await restoreConsoleLinkReply(result.reply.text, request.chatId, request.messageId, this.options.consoleLinkResolver) } };
    return result;
  }

  private validate(request: DirectCall) {
    const schemas = { ...ToolArguments, ...AUTOMATION_ARGUMENTS, ...BACKGROUND_ARGUMENTS,
      confirm_pending: z.object({}).strict(), cancel_plan: CancelPlanArgumentsSchema, cancel_goal: z.object({}).strict() };
    const schema = schemas[request.name as keyof typeof schemas];
    if (!schema) throw new DirectToolRejectedError(400, "UNKNOWN_TOOL", "没有这个业务工具。只使用工具列表里的工具。");
    if (request.name === "create_automation") assertAutomationKind(request.arguments);
    const parsed = schema.safeParse(request.arguments);
    if (!parsed.success) throw invalidArguments(parsed.error);
    if (!this.options.goalsAvailable && ["execute_goal", "propose_goal"].includes(request.name)) throw goalsUnavailable();
    if (AUTOMATION_TOOL_NAMES.has(request.name) && !this.options.automations || BACKGROUND_TOOL_NAMES.has(request.name) && !this.options.background) {
      throw new DirectToolRejectedError(503, "TOOL_UNAVAILABLE", "这个业务工具当前不可用。告诉用户该功能暂时不能用，不要重试。");
    }
    this.checkApproval(request);
  }

  private async settingsView(request: DirectRequest): Promise<LocalRuntimeSettings | undefined> {
    const settings = this.options.settings;
    if (!settings) return undefined;
    // A disjoint journal namespace stores snapshots, never real user text or conversation history.
    const messageId = `direct_settings_${hash([request.messageId])}`;
    const snapshotReference = hash(["direct-settings-snapshot", request.chatId, request.messageId, request.text]);
    let frozen = await this.options.store.getMessage(request.chatId, messageId);
    if (!frozen) {
      settings.persistTurnSnapshot(snapshotReference, settings.turnSnapshot());
      await this.options.store.recordMessage({ chatId: request.chatId, messageId,
        text: hash(request.text), replyText: JSON.stringify({ reference: snapshotReference }), createdAt: new Date(this.options.now()).toISOString() });
      frozen = await this.options.store.getMessage(request.chatId, messageId);
    }
    if (!frozen || frozen.text !== hash(request.text)) throw new DirectToolRejectedError(409, "SETTINGS_SNAPSHOT_MISMATCH", "本轮的配置快照与这条消息不一致。不要重试，告诉用户请重新发送消息。");
    let value: unknown;
    try {
      const marker = JSON.parse(frozen.replyText) as unknown;
      const reference = marker && typeof marker === "object" && "reference" in marker && typeof marker.reference === "string"
        ? marker.reference : undefined;
      value = reference ? settings.readTurnSnapshot(reference) : marker;
      if (value === null || value === undefined) throw new Error("Missing runtime snapshot");
    }
    catch { throw new DirectToolRejectedError(503, "SETTINGS_SNAPSHOT_UNREADABLE", "本轮的配置快照无法读取。不要重试，告诉用户请重新发送消息。"); }
    try { return settings.restoreTurn(value); }
    catch (error) {
      const status = error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 503;
      throw new DirectToolRejectedError(status, "SETTINGS_SNAPSHOT_INCOMPATIBLE", "本轮的配置快照已不兼容当前版本。不要重试，告诉用户请重新发送消息。");
    }
  }

  private async context(request: DirectRequest): Promise<LeaderData> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const saved = await this.options.store.getLeaderState(request.chatId);
      const data = LeaderDataSchema.parse(saved?.data ?? {}), inputHash = hash(request.text);
      const expiredSteer = data.inflight && data.inflight.expiresAt <= this.options.now() &&
        data.inflight.plan?.actions.length === 1 && data.inflight.plan.actions[0].deliveryMode === "steer";
      if (!expiredSteer && data.directContext?.messageId === request.messageId && data.directContext.inputHash === inputHash && data.directContext.expiresAt > this.options.now()) return data;
      if (data.inflight && data.inflight.expiresAt > this.options.now()) throw chatBusy();
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
    throw new DirectToolRejectedError(409, "CHAT_STATE_CHANGING", "本聊天的状态在反复变化。稍后重新查询一次再调用。");
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
        if (!hub.listAutomations) throw new CommandError(503, "这台机器的定时任务列表当前不可查询。告诉用户暂时无法查看，不要重试。");
        return hub.listAutomations(node, signal);
      }, inspectAutomation: (node: string, args: Parameters<NonNullable<Hub["inspectAutomation"]>>[1], signal?: AbortSignal) => {
        if (!hub.inspectAutomation) throw new CommandError(503, "这台机器的定时任务详情当前不可查询。告诉用户暂时无法查看，不要重试。");
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
        if (!context || context.messageId !== request.messageId || context.inputHash !== hash(request.text) || context.expiresAt <= o.now() || latest.inflight) throw discoveryChanged();
        context.discoveredRunIds = [...new Set([...context.discoveredRunIds, ...authority.discoveredRunIds])];
        for (const [node, ids] of authority.discoveredSources) context.discoveredSources[node] = [...new Set([...(context.discoveredSources[node] ?? []), ...ids])];
        context.discoveredSessions = [...new Map([...context.discoveredSessions, ...sessions].map(item => [JSON.stringify([item.nodeId, item.id]), item])).values()];
        LeaderDataSchema.parse(latest);
        if (await o.store.compareAndSetLeaderState(request.chatId, saved?.revision ?? 0, latest)) { merged = true; break; }
      }
      if (!merged) throw discoveryChanged();
    }
    const reply = request.name === "list_sessions" && parseSessionDirectoryQuery(request.text) ? { text: titles.render("") } : undefined;
    if (reply) await o.store.recordMessage({ chatId: request.chatId, messageId: request.messageId, text: request.text, replyText: reply.text, createdAt: new Date().toISOString() });
    return { result: this.renderResult(result, titles), ...(reply ? { reply } : {}) };
  }

  private async run(request: DirectCall): Promise<DirectToolResult> {
    const o = this.options, { chatId, messageId, name } = request;
    const saved = await o.store.getLeaderState(chatId);
    const data = LeaderDataSchema.parse(saved?.data ?? {});
    if (data.inflight && data.inflight.expiresAt > o.now()) throw chatBusyAfterStart();
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
        throw new CommandError(409, "本轮处理授权已变化或过期。先查询实际状态再告诉用户，不要再调一次。");
      }
    };
    const authority: BackgroundToolAuthority = { chatId, currentMessageId: messageId, operations: new Set(BACKGROUND_OPERATION_BY_TOOL[name] ? [BACKGROUND_OPERATION_BY_TOOL[name]] : []),
      discoveredRunIds: new Set(data.directContext.discoveredRunIds),
      discoveredSources: new Map(Object.entries(data.directContext.discoveredSources).map(([node, ids]) => [node, new Set(ids)])),
      assertCurrentAuthority: assertAuthority };
    const link: LinkContext = { requestId: consoleLinkRequestId(chatId, messageId) };
    const titles = this.titles(data);
    const signal = AbortSignal.timeout(TURN_TIMEOUT_MS);
    let result: unknown, reply: LeaderReply | undefined;
    try {
      this.checkApproval(request);
      if (BACKGROUND_TOOL_NAMES.has(name)) {
        if (!o.background) throw new CommandError(503, "后台任务工具当前不可用。告诉用户该功能暂时不能用，不要重试。");
        result = await traceSpan("leader.tool", () => executeBackgroundTool(o.background!, this.sourceHub(), name, request.arguments, authority, signal), { tool: name, source: "direct" });
      } else if (AUTOMATION_TOOL_NAMES.has(name)) {
        if (!o.automations) throw new CommandError(503, "定时任务工具当前不可用。告诉用户该功能暂时不能用，不要重试。");
        const raw = request.arguments;
        const background = raw !== null && typeof raw === "object" && "kind" in raw && raw.kind === "background";
        let executorAuthorizationError: BackgroundExecutorAuthorizationError | undefined;
        if (name === "create_automation" && background) {
          const spec = BackgroundSpecSchema.parse("background" in raw ? raw.background : undefined);
          assertBackgroundSourcesDiscovered(authority, spec.sources);
          try { await assertBackgroundExecutorAuthorized(o.backgroundExecutorAuthorizationModel, request.text, spec, signal); }
          catch (error) {
            if (!(error instanceof BackgroundExecutorAuthorizationError)) throw error;
            executorAuthorizationError = error;
          }
        }
        await assertAuthority();
        result = executorAuthorizationError ? { error: executorAuthorizationError.message, code: "BACKGROUND_EXECUTOR_NOT_AUTHORIZED" }
          : await traceSpan("leader.tool", () => executeAutomationTool(o.automations!, name, raw, {
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
          throw new DirectToolRejectedError(409, "NO_UNIQUE_PENDING", "没有能由这条消息确认的唯一待确认计划或目标。先问用户要确认哪一个，不要替用户确认。");
        }
        if (priorPlan && !explicitGoal) {
          data.inflight.plan = priorPlan; data.pending = undefined;
          claimed = await o.save(chatId, claimed.revision, data);
          reply = await o.executePlan(chatId, claimed.revision, priorPlan, data);
        } else {
          if (!o.goalsAvailable) throw goalsUnavailable();
          data.inflight.goal = priorGoal!; data.pendingGoal = undefined;
          claimed = await o.save(chatId, claimed.revision, data);
          reply = await o.confirmGoal(chatId, claimed.revision, priorGoal!, data);
        }
        result = reply;
      } else if (name === "cancel_goal" || name === "cancel_plan") {
        const { planId }: { planId?: string } = (name === "cancel_plan" ? CancelPlanArgumentsSchema : z.object({}).strict()).parse(request.arguments);
        await assertAuthority();
        if (name === "cancel_goal") { data.pendingGoal = undefined; reply = await o.goals.cancel(chatId); }
        else {
          data.pending = undefined;
          const cancelled = await cancelActivePlan(o.store, o.executions, chatId, planId);
          reply = { text: cancelled.kind === "cancelled" ? "已取消计划后续派发，原会话当前执行未停止；如需停止正在运行的轮次，请明确告诉我停止哪个会话。"
            : cancelled.kind === "ambiguous" ? `已取消待确认计划。${ambiguousCancellationText(cancelled.plans)}`
            : cancelled.kind === "missing" ? "已取消待确认计划；没有该ID的进行中计划，未停止其他计划。" : "已取消待确认计划；没有活动计划。" };
        }
        result = reply;
      } else if (name === "send_session_images") {
        const target = ToolArguments.send_session_images.parse(request.arguments);
        if (!o.hub.listMedia || !o.hub.readMedia) throw new DirectToolRejectedError(503, "IMAGES_UNAVAILABLE", "发图功能当前不可用。告诉用户暂时不能发图，不要重试。");
        const session = o.hub.getNodeSession(target.nodeId, target.sessionId);
        if (!o.hub.isNodeConnected(target.nodeId) || !session?.capabilities.includes("read")) throw new DirectToolRejectedError(403, "IMAGE_SOURCE_UNAVAILABLE", "目标会话当前离线或不可读取。告诉用户该会话的图片暂时拿不到，不要重试。");
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
        } else if ((name === "interrupt_session" || name === "answer_approval") && result && typeof result === "object" && "receipt" in result && typeof result.receipt === "string") {
          reply = { text: result.receipt, ...("commandId" in result && typeof result.commandId === "string" ? { commandId: result.commandId } : {}) };
        } else if (name === "get_console_link" && link.issuedLink) {
          reply = { text: `控制台登录链接（签发后1小时内可重复登录）：\n${link.issuedLink.url}` };
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
        await o.store.recordMessage({ chatId, messageId, text: request.text,
          replyText: redactIssuedConsoleLink(reply.text, link.requestId, link.issuedLink?.url),
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

  /** Permission follows the tool and its arguments; only deterministic facts are checked here. */
  private checkApproval(request: DirectCall) {
    if (request.name !== "answer_approval") return;
    const target = ToolArguments.answer_approval.safeParse(request.arguments);
    if (!target.success) throw invalidArguments(target.error);
    const failure = approvalAuthorizationFailure(request.text, target.data.decision,
      this.options.hub.getNodeSession(target.data.nodeId, target.data.sessionId), target.data);
    if (failure) throw new DirectToolRejectedError(403, "APPROVAL_REJECTED", failure);
  }
}
