import { createHash } from "node:crypto";
import * as path from "node:path";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { type CodexOptions, type ThreadOptions, type ThreadEvent, type TurnOptions } from "@openai/codex-sdk";
import type { ControllerClient } from "../controller/client.js";
import type { ControllerMessageRequest, ControllerMessageResponse } from "../types.js";
import { WorkspaceStore, MAX_REPLY_CHARS, MAX_REPLY_JOURNAL_ENTRIES, MAX_PINNED_REPLY_ENTRIES,
  MAX_CLOSED_REPLY_ENTRIES, MAX_REPLY_JOURNAL_BYTES, MAX_REPLY_ENTRY_BYTES,
  type ReplyJournal, type LeaderWorkspace } from "./workspace.js";
import { ReplyEngineBackpressureError, ReplyEngineConflictError, ReplyEngineUnavailableError,
  type GatewayReplyEngine, type ControllerToolClient, type ReplyEngineTurnOptions } from "./contracts.js";
import { ControlMcp, CONTROL_TOKEN_ENV, hasConsoleCredential, redactConsoleCredentials } from "./control-mcp.js";
import { DEFAULT_CONTROLLER_TIMEOUT_MS, DEFAULT_CONTROLLER_MAX_RETRIES } from "../runtime/budgets.js";
import { HEADLESS_CODEX_CONFIG, HEADLESS_SKILLS_ROOT } from "./headless-config.js";
import { traceEvent, traceSpan } from "../runtime/telemetry.js";
import { NativeEventTrace, nativeId } from "./native-events.js";
import { buildLeaderPrompt as prompt } from "./prompt.js";
import { isConsoleLinkQuery, parseSessionDirectoryQuery } from "@super-leader/wechat-text";
import { combineReplyText, restoreConsoleReply } from "./reply-content.js";
import { startAppServerTurn, AppServerRejectedError, type AppServerTurn } from "./app-server.js";

const DEFAULT_TIMEOUT_MS = 300000;
const MAX_TIMEOUT_MS = 315000;
// Upstream exec shutdown allows a 35s acknowledgement budget, including analytics flush.
const DEFAULT_CLEANUP_TIMEOUT_MS = 40_000;
const STOP_ABORT_GRACE_MS = 2_000;
const UNCERTAIN_REPLY = "上次处理这条消息的结果尚不明确，为避免重复执行，我没有自动重跑。请查询任务状态后再决定下一步。";
const FAILED_REPLY = "这次处理没有正常完成，执行结果待核实。我保留了会话和记忆，请先查询任务状态，避免重复执行。";
const ENV_ALLOWLIST = ["PATH", "LANG", "LC_ALL", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"] as const;
// Instances within one process share locks. Each workspace root must still be
// owned exclusively by one Gateway process; cross-process writers are unsupported.
const CHAT_LOCKS = new Map<string, Promise<void>>();
const JOURNAL_LOCKS = new Map<string, Promise<void>>();
const ACTIVE_REPLIES = new Map<string, { inputHash: string; reply: Promise<ControllerMessageResponse> }>();

interface ThreadRunner {
  runStreamed(input: string, options: TurnOptions & { signal: AbortSignal }): Promise<{ events: AsyncIterable<ThreadEvent> }>;
}
interface CodexClient {
  startThread(options: ThreadOptions): ThreadRunner;
  resumeThread(id: string, options: ThreadOptions): ThreadRunner;
}
export interface CodexReplyEngineOptions {
  root: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  codexPath?: string;
  timeoutMs?: number;
  cleanupTimeoutMs?: number;
  sdkFactory?: (options: CodexOptions) => CodexClient;
  appServerFactory?: typeof startAppServerTurn;
}

interface ActiveQuery {
  request: ControllerMessageRequest;
  ready: Promise<boolean>;
  resolveReady: (ready: boolean) => void;
  accepting: boolean;
  workspace?: LeaderWorkspace;
  native?: AppServerTurn;
  control?: ControlMcp;
  pending: Promise<void>;
  supplemented: boolean;
  uncertain: boolean;
}

function activeQuery(request: ControllerMessageRequest): ActiveQuery {
  let resolveReady!: (ready: boolean) => void;
  const ready = new Promise<boolean>(resolve => { resolveReady = resolve; });
  return { request, ready, resolveReady, accepting: true, pending: Promise.resolve(), supplemented: false, uncertain: false };
}

function hash(text: string): string { return createHash("sha256").update(text).digest("hex"); }

function runtimeReadPath(codexPath?: string): string {
  if (codexPath) return realpathSync(codexPath);
  const sdkRequire = createRequire(import.meta.resolve("@openai/codex-sdk"));
  const codexRequire = createRequire(sdkRequire.resolve("@openai/codex/package.json"));
  const platform = process.platform === "android" ? "linux" : process.platform;
  return path.dirname(codexRequire.resolve(`@openai/codex-${platform}-${process.arch}/package.json`));
}

function permissionOverrides(workspace: LeaderWorkspace, codexPath?: string): string[] {
  const filesystem = [
    [":minimal", "read"],
    [HEADLESS_SKILLS_ROOT, "read"],
    [workspace.workspacePath, "write"],
    [workspace.codexHome, "deny"],
    [path.join(workspace.workspacePath, ".replies.json"), "deny"],
    [path.join(workspace.workspacePath, ".thread.json"), "deny"],
    [path.join(workspace.workspacePath, "AGENTS.md"), "read"],
    ["/etc/super-leader", "deny"],
    ["/proc", "deny"],
    [runtimeReadPath(codexPath), "read"],
  ].map(([file, access]) => `${JSON.stringify(file)}=${JSON.stringify(access)}`).join(",");
  // Inline TOML avoids SDK dotted-key flattening corrupting filesystem paths.
  // No parent profile is inherited: only runtime paths, skills and this chat are readable.
  return [`permissions.wechat_memory={filesystem={${filesystem}},network={enabled=true}}`];
}

/** Each chat owns its Codex home, native thread, memory, and durable reply journal. */
interface NativeOutcome {
  reply: ControllerMessageResponse;
  stage: "started" | "completed";
  provenance?: "controller-console";
  consoleText?: string;
  controllerMessageId?: string;
}

function pinned(entry: ReplyJournal[string]): boolean {
  return entry.stage === "started" || !["accepted", "expired"].includes(entry.delivery ?? "pending");
}

function pruneClosed(journal: ReplyJournal): void {
  const closed = Object.keys(journal).filter(key => !pinned(journal[key]));
  for (const key of closed.slice(0, Math.max(0, closed.length - MAX_CLOSED_REPLY_ENTRIES))) delete journal[key];
}

function reserveJournalEntry(journal: ReplyJournal): void {
  pruneClosed(journal);
  if (Object.values(journal).filter(pinned).length >= MAX_PINNED_REPLY_ENTRIES) throw new ReplyEngineBackpressureError();
  // Reserve a worst-case response before any native execution. Only closed,
  // acknowledged entries may make room; pending and unknown work stays pinned.
  const closed = Object.keys(journal).filter(id => !pinned(journal[id]));
  while (Object.keys(journal).length >= MAX_REPLY_JOURNAL_ENTRIES ||
    Buffer.byteLength(JSON.stringify(journal) + "\n", "utf8") + MAX_REPLY_ENTRY_BYTES + 128 > MAX_REPLY_JOURNAL_BYTES) {
    const removable = closed.shift();
    if (!removable) throw new ReplyEngineBackpressureError();
    delete journal[removable];
  }
}

export class CodexReplyEngine implements GatewayReplyEngine {
  private readonly active = new Map<string, ActiveQuery>();
  private readonly store: WorkspaceStore;
  private readonly timeoutMs: number;
  private readonly lockScope: string;
  private readonly cleanupTimeoutMs: number;
  private readonly background = new Set<Promise<void>>();
  private readonly nativeAborts = new Set<AbortController>();
  private stopping = false;
  private stopPromise?: Promise<void>;

  constructor(private readonly options: CodexReplyEngineOptions) {
    if (!options.model?.trim()) throw new Error("A Codex reply model is required");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > MAX_TIMEOUT_MS) {
      throw new Error("Invalid Codex reply timeout budget");
    }
    this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.cleanupTimeoutMs) || this.cleanupTimeoutMs <= 0 || this.cleanupTimeoutMs > MAX_TIMEOUT_MS) {
      throw new Error("Invalid Codex cleanup timeout budget");
    }
    this.store = new WorkspaceStore(options.root);
    // WorkspaceStore rejects symlink paths; normalized absolute paths identify
    // the same supported root even when callers use relative paths or dot segments.
    this.lockScope = path.resolve(options.root);
  }

  public get requestBudgetMs(): number {
    return this.timeoutMs + DEFAULT_CONTROLLER_TIMEOUT_MS * (DEFAULT_CONTROLLER_MAX_RETRIES + 1);
  }

  public async reply(accountId: string, request: ControllerMessageRequest,
    controller: ControllerToolClient, options: ReplyEngineTurnOptions = {}): Promise<ControllerMessageResponse> {
    if (!request.messageId?.trim() || !request.text?.trim()) throw new Error("A stable message ID and text are required");
    const frozen = Object.freeze({ ...request });
    if (this.stopping) throw new ReplyEngineUnavailableError();
    const activeKey = this.messageKey(accountId, frozen.chatId, frozen.messageId);
    const active = ACTIVE_REPLIES.get(activeKey);
    if (active) {
      if (active.inputHash !== hash(frozen.text)) throw new ReplyEngineConflictError();
      return this.getReply(accountId, frozen.chatId, frozen.messageId, controller);
    }
    let publish!: (reply: ControllerMessageResponse) => void;
    let fail!: (error: unknown) => void;
    const reply = new Promise<ControllerMessageResponse>((resolve, reject) => { publish = resolve; fail = reject; });
    const entry = { inputHash: hash(frozen.text), reply };
    ACTIVE_REPLIES.set(activeKey, entry);
    const queryKey = hash(JSON.stringify([accountId, frozen.chatId]));
    let query: ActiveQuery | undefined;
    if (!this.active.has(queryKey)) this.active.set(queryKey, query = activeQuery(frozen));
    const job = this.withChatLock(accountId, frozen.chatId,
      release => {
        if (this.stopping) throw new ReplyEngineUnavailableError();
        if (!query) this.active.set(queryKey, query = activeQuery(frozen));
        return this.run(accountId, frozen, controller, publish, release, query, options);
      }).then(publish, error => {
        traceEvent("codex.run.failed");
        fail(error);
      }).finally(() => {
        if (query) {
          query.accepting = false;
          query.resolveReady(false);
          if (this.active.get(queryKey) === query) this.active.delete(queryKey);
        }
        this.background.delete(job);
        if (ACTIVE_REPLIES.get(activeKey) === entry) ACTIVE_REPLIES.delete(activeKey);
      });
    this.background.add(job);
    return reply;
  }

  public async steer(accountId: string, request: ControllerMessageRequest,
    _controller: ControllerToolClient): Promise<boolean> {
    if (!request.messageId?.trim() || !request.text?.trim()) throw new Error("A stable message ID and text are required");
    const existing = await this.withJournalLock(accountId, request.chatId, async () => {
      const workspace = await this.store.findChat(accountId, request.chatId);
      return workspace?.getReplyJournal()[hash(request.messageId)];
    });
    if (existing && existing.inputHash !== hash(request.text)) throw new ReplyEngineConflictError();
    if (existing?.steering) return true;
    const query = this.active.get(hash(JSON.stringify([accountId, request.chatId])));
    if (!query || !await query.ready) return false;
    const frozen = Object.freeze({ ...request });
    const result = query.pending.then(() => this.append(accountId, query, frozen));
    // Keep the sequencing tail usable; the caller still receives the original rejection.
    query.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  private async append(accountId: string, query: ActiveQuery, request: ControllerMessageRequest): Promise<boolean> {
    if (!query.accepting || !query.native || !query.workspace || !query.control) return false;
    const workspace = query.workspace;
    const key = hash(request.messageId);
    const releaseAuthority = query.control.beginAppend();
    try {
      const existing = await this.withJournalLock(accountId, request.chatId, async () => {
        const journal = workspace.getReplyJournal();
        const previous = journal[key];
        if (previous) {
          if (previous.inputHash !== hash(request.text)) throw new ReplyEngineConflictError();
          return previous;
        }
        reserveJournalEntry(journal);
        journal[key] = { inputHash: hash(request.text), stage: "started", delivery: "pending", reply: { text: "" },
          steering: { rootMessageId: query.request.messageId, threadId: query.native!.threadId,
            turnId: query.native!.turnId, status: "submitting" } };
        workspace.setReplyJournal(journal);
        return undefined;
      });
      if (existing) return Boolean(existing.steering);
      try {
        await query.native.steer(`<current_user_message>${JSON.stringify({ messageId: request.messageId, text: redactConsoleCredentials(request.text) })}</current_user_message>
后续业务工具调用填写 requestMessageId 为当前实际 messageId，按完整合并的本轮原文重新选择工具和参数，不复用补充消息之前的旧参数。`, query.native.turnId);
      } catch (error) {
        await this.withJournalLock(accountId, request.chatId, async () => {
          const latest = workspace.getReplyJournal();
          if (error instanceof AppServerRejectedError) delete latest[key];
          else {
            query.uncertain = true;
            query.control!.invalidateAuthority();
            latest[key].steering!.status = "uncertain";
          }
          workspace.setReplyJournal(latest);
        });
        return !(error instanceof AppServerRejectedError);
      }
      try {
        query.control.appendRequest(request);
        query.supplemented = true;
        await this.withJournalLock(accountId, request.chatId, async () => {
          const latest = workspace.getReplyJournal();
          latest[key] = { ...latest[key], stage: "completed", delivery: "accepted",
            steering: { ...latest[key].steering!, status: "accepted" } };
          pruneClosed(latest);
          workspace.setReplyJournal(latest);
        });
      } catch (error) {
        query.uncertain = true;
        query.control.invalidateAuthority();
        throw error;
      }
      return true;
    } finally { releaseAuthority(); }
  }

  /** Wait for tracked work without changing admission; useful for ordered shutdown and tests. */
  public async drain(): Promise<void> {
    while (this.background.size) await Promise.all([...this.background]);
  }

  /** Stop admission, allow normal cleanup, then abort overdue native processes and drain. */
  public stop(): Promise<void> {
    this.stopping = true;
    return this.stopPromise ??= this.stopWork();
  }

  private async stopWork(): Promise<void> {
    const drain = this.drain();
    const wait = async (timeoutMs: number): Promise<boolean> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([drain.then(() => true), new Promise<false>(resolve => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        })]);
      } finally { clearTimeout(timer); }
    };
    if (await wait(this.cleanupTimeoutMs)) return;
    traceEvent("codex.cleanup.stop_budget_exceeded", { pendingRuns: this.background.size });
    for (const abort of this.nativeAborts) abort.abort();
    if (!await wait(STOP_ABORT_GRACE_MS)) throw new Error("Codex cleanup did not drain within the shutdown budget");
  }

  public async getReply(accountId: string, chatId: string, messageId: string,
    controller: Partial<Pick<ControllerClient, "getMessageReply">>): Promise<ControllerMessageResponse> {
    if (!messageId?.trim()) throw new Error("A stable message ID is required");
    await this.awaitActiveReply(accountId, chatId, messageId);
    return this.withJournalLock(accountId, chatId, async () => {
      const workspace = await traceSpan("codex.workspace.find", () => this.store.findChat(accountId, chatId));
      const entry = workspace?.getReplyJournal()[hash(messageId)];
      if (!entry || ["uncertain", "expired"].includes(entry.delivery ?? "pending")) throw new ReplyEngineUnavailableError();
      return this.recover(entry, chatId, messageId, controller);
    });
  }

  public async ackReply(accountId: string, chatId: string, messageId: string,
    status: "accepted" | "uncertain" | "expired"): Promise<void> {
    if (!messageId?.trim()) throw new Error("A stable message ID is required");
    if (!["accepted", "uncertain", "expired"].includes(status)) throw new Error("Invalid Codex delivery status");
    await this.awaitActiveReply(accountId, chatId, messageId);
    await this.withJournalLock(accountId, chatId, async () => {
      const workspace = await traceSpan("codex.workspace.find", () => this.store.findChat(accountId, chatId));
      // A terminal receipt can outlive its pruned journal entry. Repeating it
      // must not recreate workspaces or prevent Gateway from draining outbox.
      if (!workspace) return;
      const journal = workspace.getReplyJournal();
      const key = hash(messageId);
      const entry = journal[key];
      if (!entry) return;
      if ((entry.delivery ?? "pending") !== "pending") return; // First terminal receipt wins.
      delete journal[key];
      journal[key] = { ...entry, delivery: status };
      pruneClosed(journal);
      await traceSpan("codex.journal.delivery.save", async () => workspace.setReplyJournal(journal), { receiptStatus: status });
    });
  }

  private async awaitActiveReply(accountId: string, chatId: string, messageId: string): Promise<void> {
    try { await ACTIVE_REPLIES.get(this.messageKey(accountId, chatId, messageId))?.reply; }
    catch { traceEvent("codex.recovery.active_failed"); }
    // The original caller receives its failure. Recovery always reads the last
    // durable fact, including a pinned started entry after a failed final write.
  }

  private messageKey(accountId: string, chatId: string, messageId: string): string {
    return hash(JSON.stringify([this.lockScope, accountId, chatId, messageId]));
  }

  private withJournalLock<T>(accountId: string, chatId: string, action: () => Promise<T>): Promise<T> {
    return this.withLock(JOURNAL_LOCKS, accountId, chatId, () => action(), "codex.journal_lock.wait");
  }

  private withChatLock<T>(accountId: string, chatId: string, action: (release: () => void) => Promise<T>): Promise<T> {
    return this.withLock(CHAT_LOCKS, accountId, chatId, action, "codex.chat_lock.wait");
  }

  private async withLock<T>(locks: Map<string, Promise<void>>, accountId: string, chatId: string,
    action: (release: () => void) => Promise<T>, stage: string): Promise<T> {
    const key = hash(JSON.stringify([this.lockScope, accountId, chatId]));
    const queued = locks.has(key);
    const prior = locks.get(key) ?? Promise.resolve();
    let unlock!: () => void;
    let released = false;
    const current = new Promise<void>(resolve => { unlock = resolve; });
    const release = () => {
      if (released) return;
      released = true;
      unlock();
      if (locks.get(key) === current) locks.delete(key);
    };
    locks.set(key, current);
    await traceSpan(stage, () => prior, { queued });
    try { return await action(release); }
    finally { release(); }
  }

  private async recover(entry: ReplyJournal[string], chatId: string, messageId: string,
    controller: Partial<Pick<ControllerClient, "getMessageReply">>): Promise<ControllerMessageResponse> {
    if (entry.provenance === "controller-console") {
      if (!controller.getMessageReply) throw new ReplyEngineUnavailableError();
      const raw = await controller.getMessageReply(chatId, entry.controllerMessageId ?? messageId);
      const reply = restoreConsoleReply(entry, raw);
      return reply.images?.length && entry.controllerMessageId
        ? { ...reply, imageSourceMessageId: entry.controllerMessageId } : reply;
    }
    return entry.reply ?? { text: UNCERTAIN_REPLY };
  }

  private async run(accountId: string, request: ControllerMessageRequest,
    controller: ControllerToolClient,
    publish: (reply: ControllerMessageResponse) => void, release: () => void,
    query: ActiveQuery, options: ReplyEngineTurnOptions): Promise<ControllerMessageResponse> {
    const workspace = await traceSpan("codex.workspace.open", () => this.store.forChat(accountId, request.chatId));
    const prepared = await this.withJournalLock(accountId, request.chatId, async () => {
      const journal = await traceSpan("codex.journal.read", async () => workspace.getReplyJournal());
      const key = hash(request.messageId);
      const inputHash = hash(request.text);
      const previous = journal[key];
      if (previous) {
        traceEvent("codex.journal.reused", { status: previous.stage, receiptStatus: previous.delivery });
        if (previous.inputHash !== inputHash) throw new ReplyEngineConflictError();
        if (["uncertain", "expired"].includes(previous.delivery ?? "pending")) throw new ReplyEngineUnavailableError();
        return { reply: await this.recover(previous, request.chatId, request.messageId,
          controller as Partial<Pick<ControllerClient, "getMessageReply">>) };
      }
      reserveJournalEntry(journal);
      journal[key] = { inputHash, stage: "started", delivery: "pending", reply: { text: UNCERTAIN_REPLY } };
      await traceSpan("codex.journal.started.save", async () => workspace.setReplyJournal(journal));
      return undefined;
    });
    if (prepared) return prepared.reply;
    const key = hash(request.messageId);
    const inputHash = hash(request.text);
    let outcome: NativeOutcome;
    let published: NativeOutcome | undefined;
    let publicationError: { cause: unknown } | undefined;
    const saveOutcome = async (result: NativeOutcome): Promise<void> => this.withJournalLock(accountId, request.chatId, async () => {
      const journal = workspace.getReplyJournal();
      const delivery = journal[key]?.delivery ?? "pending";
      journal[key] = { inputHash, stage: result.stage, delivery,
        ...(result.provenance ? { provenance: result.provenance } : {}),
        ...(result.controllerMessageId ? { controllerMessageId: result.controllerMessageId } : {}),
        ...(result.consoleText ? { consoleText: redactConsoleCredentials(result.consoleText) } : {}),
        reply: result.provenance ? { ...result.reply, text: redactConsoleCredentials(result.reply.text) } : result.reply };
      await traceSpan("codex.journal.outcome.save", async () => workspace.setReplyJournal(journal), { status: result.stage });
    });
    const directoryQuery = parseSessionDirectoryQuery(request.text);
    const consoleQuery = isConsoleLinkQuery(request.text);
    try {
      if (directoryQuery || consoleQuery) {
        query.resolveReady(false);
        const name = directoryQuery ? "list_sessions" : "get_console_link";
        const args = directoryQuery ?? {};
        const reply = await traceSpan(directoryQuery ? "codex.directory.controller" : "codex.console.controller", async () => {
          const listed = await controller.listTools(request);
          if (!listed.tools.some(tool => tool.name === name)) throw new ReplyEngineUnavailableError();
          const called = await controller.callTool({ ...request, name, arguments: args,
            callId: hash(JSON.stringify([request.messageId, name, args])) });
          if (!called.reply) throw new ReplyEngineUnavailableError();
          return called.reply;
        });
        outcome = { reply, stage: "completed", ...(hasConsoleCredential(reply.text)
          ? { provenance: "controller-console" as const, consoleText: reply.text } : {}) };
      } else outcome = await this.nativeTurn(workspace, request, controller, async result => {
        try { await saveOutcome(result); }
        catch (cause) { publicationError = { cause }; throw cause; }
        published = result;
        traceEvent("codex.reply.ready", { status: result.stage, cleanupPending: true });
        publish(result.reply);
      }, release, query, options);
    } catch {
      traceEvent(directoryQuery ? "codex.directory.failed" : consoleQuery ? "codex.console.failed" : "codex.native.failed");
      outcome = { reply: { text: FAILED_REPLY }, stage: "started" };
    }
    if (publicationError) throw publicationError.cause;
    // An exit/cleanup failure cannot revoke or overwrite an already delivered,
    // durable turn result. Receipts use the independent journal lock.
    if (published) return published.reply;
    // Persistence errors escape. The original started entry still prevents
    // another model run, and Gateway must not send a reply it cannot recover.
    await saveOutcome(outcome);
    return outcome.reply;
  }

  private async nativeTurn(workspace: LeaderWorkspace, request: ControllerMessageRequest,
    controller: ControllerToolClient,
    onCompleted: (result: NativeOutcome) => Promise<void>, releaseExecution: () => void,
    query: ActiveQuery, options: ReplyEngineTurnOptions): Promise<NativeOutcome> {
    const control = new ControlMcp(request, controller, options);
    const abort = new AbortController();
    this.nativeAborts.add(abort);
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => abort.abort(), this.timeoutMs);
    let started = false;
    let nativeEvents: NativeEventTrace | undefined;
    let native: AppServerTurn | undefined;
    let drained = false;
    let replyReady = false;
    let processExited = false;
    let text = "";
    let completed = false;
    let failed = false;
    let aborted = false;
    const result = (nativeComplete: boolean): NativeOutcome | undefined => {
      const sideband = control.result;
      if (control.wasCalled && !sideband) return;
      // Query-only tool results still need native analysis. Confirmed business
      // receipts survive a failed narration without borrowing unfinished prose.
      if (!nativeComplete && (!sideband || !control.authoritativeText)) return;
      const reply: ControllerMessageResponse = { text: (sideband && control.authoritativeText
        ? nativeComplete
          ? combineReplyText(text, sideband.text, control.hasQueryResults || query.supplemented, control.consoleText)
          : sideband.text
        : redactConsoleCredentials(text)).slice(0, MAX_REPLY_CHARS),
        ...(sideband?.commandId ? { commandId: sideband.commandId } : {}),
        ...(sideband?.images ? { images: structuredClone(sideband.images),
          ...(control.resultMessageId && control.resultMessageId !== request.messageId
            ? { imageSourceMessageId: control.resultMessageId } : {}) } : {}) };
      return { reply, stage: "completed", ...(control.consoleText
        ? { provenance: "controller-console" as const, consoleText: control.consoleText,
          ...(control.resultMessageId !== request.messageId ? { controllerMessageId: control.resultMessageId } : {}) } : {}) };
    };
    try {
      await traceSpan("codex.mcp.start", () => control.start());
      started = true;
      const env: Record<string, string> = { HOME: workspace.workspacePath, CODEX_HOME: workspace.codexHome,
        [CONTROL_TOKEN_ENV]: control.token };
      for (const name of ENV_ALLOWLIST) if (process.env[name] !== undefined) env[name] = process.env[name]!;
      const config: NonNullable<CodexOptions["config"]> = {
        ...HEADLESS_CODEX_CONFIG,
        default_permissions: "wechat_memory",
        shell_environment_policy: { exclude: ["CODEX_API_KEY", "OPENAI_API_KEY", CONTROL_TOKEN_ENV] },
        mcp_servers: { ...HEADLESS_CODEX_CONFIG.mcp_servers,
          wechat_control: { url: control.url, bearer_token_env_var: CONTROL_TOKEN_ENV,
          enabled_tools: control.toolNames,
          tools: Object.fromEntries(control.toolNames.map(name => [name, { approval_mode: "approve" }])),
          tool_timeout_sec: Math.ceil(this.timeoutMs / 1000) } },
      };
      if (this.options.baseUrl) {
        config.model_provider = "leader_openai";
        config.model_providers = { leader_openai: { name: "Leader OpenAI-compatible API",
          base_url: this.options.baseUrl, env_key: "CODEX_API_KEY", wire_api: "responses",
          supports_standalone_web_search: true } };
      }
      const settings: CodexOptions = {
        env, config, apiKey: this.options.apiKey, baseUrl: this.options.baseUrl,
        codexPathOverride: this.options.codexPath,
        configOverrides: permissionOverrides(workspace, this.options.codexPath),
      };
      const threadOptions: ThreadOptions = { model: this.options.model, workingDirectory: workspace.workspacePath,
        approvalPolicy: "never", skipGitRepoCheck: true, webSearchMode: "live" };
      const threadId = workspace.getThreadId();
      traceEvent("codex.thread.selected", { recovery: threadId !== undefined,
        threadId: threadId ? nativeId(threadId) : undefined });
      const memory = await traceSpan("codex.memory.read", async () => workspace.readMemory());
      nativeEvents = new NativeEventTrace();
      let events: AsyncIterable<ThreadEvent>;
      if (this.options.sdkFactory) {
        const client = this.options.sdkFactory(settings);
        const thread = threadId ? client.resumeThread(threadId, threadOptions) : client.startThread(threadOptions);
        events = (await traceSpan("codex.run_streamed", () => thread.runStreamed(prompt(memory, request, control.instructions), {
          signal: abort.signal,
          onLifecycleEvent: event => {
            nativeEvents?.observeProcess(event);
            if (event.type === "child_exit") {
              processExited = true;
              if (replyReady) releaseExecution();
            }
          },
        }))).events;
        query.resolveReady(false);
      } else {
        native = await traceSpan("codex.run_streamed", () => (this.options.appServerFactory ?? startAppServerTurn)(
          settings, threadOptions, threadId, prompt(memory, request, control.instructions), abort.signal,
          startedThreadId => traceSpan("codex.thread.save", async () => { workspace.setThreadId(startedThreadId); })));
        await traceSpan("codex.thread.save", async () => workspace.setThreadId(native!.threadId));
        query.workspace = workspace;
        query.native = native;
        query.control = control;
        query.resolveReady(true);
        events = native.events;
      }
      for await (const event of events) {
        nativeEvents.observe(event);
        if (event.type === "thread.started") {
          await traceSpan("codex.thread.save", async () => workspace.setThreadId(event.thread_id));
        }
        if (event.type === "item.completed" && event.item.type === "agent_message") text = event.item.text;
        if (event.type === "turn.completed") completed = true;
        if (event.type === "turn.failed" || event.type === "error") failed = true;
        if (completed && !failed && !replyReady && nativeEvents.itemsSettled) {
          query.accepting = false;
          await query.pending;
          control.seal();
          await control.drain();
          const outcome = !abort.signal.aborted && !query.uncertain && text.trim() ? result(true) : undefined;
          if (outcome) {
            await onCompleted(outcome);
            clearTimeout(timer);
            replyReady = true;
            // A completed turn can still flush its rollout until CLI exit. Resume
            // this same thread after exit, without waiting for inherited stdio.
            if (processExited) releaseExecution();
            cleanupTimer = setTimeout(() => {
              traceEvent("codex.cleanup.budget_exceeded");
              abort.abort();
            }, this.cleanupTimeoutMs);
          }
        }
      }
      drained = true;
    } catch {
      failed = true;
      traceEvent("codex.native.failed", { aborted: abort.signal.aborted, replyAlreadyReady: replyReady });
      // Raw CLI stderr and provider failures can include credentials or file contents.
    } finally {
      query.accepting = false;
      query.resolveReady(false);
      await query.pending;
      control.seal();
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      aborted = abort.signal.aborted;
      abort.abort();
      try {
        // Keep the same-thread execution lock until native close, while durable
        // early replies and ACKs continue using the independent journal lock.
        try { if (native) await traceSpan("codex.app_server.close", () => native!.close()); }
        catch {
          failed = true;
          traceEvent("codex.native.close.failed");
        }
        nativeEvents?.finish(drained);
        // Native failure or close errors must not skip an already-submitted
        // Controller obligation; it can settle during this disconnected drain.
        if (started) {
          try { await traceSpan("codex.mcp.close", () => control.close()); }
          catch {
            failed = true;
            traceEvent("codex.mcp.close.failed");
          }
        }
      } finally { this.nativeAborts.delete(abort); }
    }
    const nativeComplete = completed && !failed && !aborted && !query.uncertain && Boolean(text.trim());
    if (!nativeComplete) {
      traceEvent("codex.native.incomplete", { turnCompletedObserved: completed, failed, aborted,
        emptyReply: !text.trim() });
    }
    return result(nativeComplete) ?? { reply: { text: FAILED_REPLY }, stage: "started" };
  }
}
