import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { controllerContextInstructions } from "../controller/direct-context.js";
import { ControllerToolFailedError, ControllerToolRejectedError, type ControllerTool, type ControllerToolList,
  type ControllerToolResult, type DirectToolClient } from "../controller/direct-tools.js";
import { validateImageAttachments, type ImageAttachment } from "../wechat/media-delivery.js";
import type { ControllerMessageRequest, ControllerMessageResponse } from "../types.js";
import { currentTrace, runWithTrace, traceEvent, traceSpan } from "../runtime/telemetry.js";
import { QueryProgress, type ProgressSink } from "./progress.js";
import { DEFAULT_PROGRESS_TOOL, parseProgressTool, validateProgressArguments, type ProgressTool } from "../settings/progress-tool.js";

const BODY_LIMIT = 1024 * 1024;
const MAX_CONTROLLER_REQUEST_CHARS = 16000;
const PROGRESS_TOOL_NAME = "report_progress";
const CONTROLLER_UNCERTAIN_TEXT = "这次调用结果不明，可能已经执行，执行结果待核实。告诉用户结果待确认，不要再调一次。";
const ASSET_TOOLS = new Set(["get_console_link", "send_session_images"]);
// Older leader threads may still send the retired attestation; it is dropped, never forwarded.
const WRAPPER_KEYS = new Set(["arguments", "requestMessageId", "authorization"]);
export const CONTROL_TOKEN_ENV = "LEADER_TURN_MCP_TOKEN";
export function hasConsoleCredential(text: string): boolean { return /#login=[A-Za-z0-9_.~%-]+/.test(text); }
export function redactConsoleCredentials(text: string): string {
  return text.replace(/#login=[A-Za-z0-9_.~%-]+/g, "#login=[REDACTED]");
}
function freezeRequestBatch(requests: readonly ControllerMessageRequest[]): ControllerMessageRequest {
  const latest = requests[requests.length - 1];
  if (requests.length === 1) return latest;
  const text = "本轮有多条尚未提交的用户消息，按接收先后排列，后面的说法优先：\n\n" +
    requests.map((request, index) => `【消息 ${index + 1}，messageId=${JSON.stringify(request.messageId)}】\n${request.text}`).join("\n\n");
  return Object.freeze({ chatId: latest.chatId, messageId: latest.messageId, text });
}
interface Batch {
  items: { request: ControllerMessageRequest; submitted: boolean }[];
  dispatched: boolean;
  released: boolean;
  request: ControllerMessageRequest;
  ready: Promise<void>;
  toolNames: Set<string>;
  instructions: string;
  mutationTail: Promise<unknown>;
}
class StaleAuthorityError extends ControllerToolRejectedError { constructor() { super(409); } }
class ReplyAssetSourceError extends ControllerToolRejectedError { constructor() { super(409); } }
interface ResponseEntry { value: ControllerToolResult; messageId: string }
/** Business authority belongs to frozen, accepted originals, never to model rewrites. */
const contextText = (listed: ControllerToolList) =>
  listed.context === undefined ? "" : controllerContextInstructions(listed.context);

export class ControlMcp {
  public readonly token = randomBytes(32).toString("hex");
  public url = "";
  private tools: ControllerTool[] = [];
  private initialListing?: ControllerToolList;
  /** Controller rules shared across turns; the turn prompt carries them as a thread layer. */
  get staticInstructions(): string { return this.initialListing?.instructions ?? ""; }
  /** This turn's chat context from the Controller; the turn prompt carries it every turn. */
  get contextInstructions(): string { return this.initialListing ? contextText(this.initialListing) : ""; }
  private batch?: Batch;
  private readonly requests: { request: ControllerMessageRequest; submitted: boolean }[] = [];
  private readonly invocations = new Map<string, Promise<ControllerToolResult>>();
  private readonly responses = new Map<string, ResponseEntry>();
  private readonly rejections = new Set<string>();
  // A successful or uncertain mutation invalidates cached read-only calls. The
  // mutation may have changed state even when its receipt is unavailable, so a
  // later read must query the Controller again instead of reusing an old result.
  private readGeneration = 0;
  private readonly appendHolds = new Set<Promise<void>>();
  private readonly progress: QueryProgress;
  private readonly progressTool: ProgressTool;
  private pending = 0;
  private failed = false;
  private uncertainMutation = false;
  private invalidAuthority = false;
  private authorityCorrection = false;
  private assetMessageId?: string;
  private shuttingDown = false;
  private shutdown?: Promise<void>;
  private readonly sessions = new Set<Server>();
  private readonly trace = currentTrace();
  private readonly server = createServer((request, response) => {
    void runWithTrace(this.trace, () => this.handle(request, response)).catch(() => {
      runWithTrace(this.trace, () => traceEvent("codex.mcp.http.failed"));
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });

  constructor(private readonly request: ControllerMessageRequest, private readonly controller: DirectToolClient,
    options: { progress?: ProgressSink; progressTool?: ProgressTool } = {}) {
    this.request = Object.freeze({ ...request });
    this.requests.push({ request: this.request, submitted: false });
    this.progress = new QueryProgress(this.request, options.progress);
    this.progressTool = parseProgressTool(JSON.stringify(options.progressTool ?? DEFAULT_PROGRESS_TOOL));
    this.server.requestTimeout = 320000;
    this.server.headersTimeout = 10000;
  }

  public async start(): Promise<void> {
    this.initialListing = await this.controller.listTools(this.request);
    if (this.initialListing.tools.some(tool => tool.name === PROGRESS_TOOL_NAME)) throw new Error("Reserved business tool name");
    this.tools = structuredClone(this.initialListing.tools);
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => { this.server.removeListener("error", reject); resolve(); });
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Control tool unavailable");
    this.url = `http://127.0.0.1:${address.port}/mcp`;
  }
  public get toolNames(): string[] { return [...this.tools.map(tool => tool.name), PROGRESS_TOOL_NAME]; }
  public get hasQueryResults(): boolean {
    return this.authorityCorrection || this.rejections.size > 0 || [...this.responses.values()].some(entry => entry.value.reply === undefined);
  }
  public get consoleText(): string | undefined {
    return [...this.responses.values()].findLast(entry => entry.value.reply && hasConsoleCredential(entry.value.reply.text))?.value.reply?.text;
  }
  public get authoritativeText(): boolean { return [...this.responses.values()].some(entry => entry.value.reply !== undefined); }
  /** A non-read-only Controller call failed after dispatch and its outcome is unknown. */
  public get hasUncertainMutation(): boolean { return this.uncertainMutation; }
  public get result(): ControllerMessageResponse | undefined {
    if (!this.wasCalled || this.pending || this.failed || this.invalidAuthority) return;
    const replies = [...this.responses.values()].flatMap(entry => entry.value.reply ? [entry.value.reply] : []);
    const images = aggregateImages(replies);
    const commandId = replies.findLast(reply => reply.commandId)?.commandId;
    return { text: replies.map(reply => reply.text).join("\n\n"), ...(commandId ? { commandId } : {}), ...(images.length ? { images } : {}) };
  }
  public get resultMessageId(): string | undefined {
    return this.result ? this.assetMessageId ?? [...this.responses.values()].at(-1)?.messageId : undefined;
  }
  public get wasCalled(): boolean { return this.invocations.size > 0; }
  public get requestCount(): number { return this.requests.length; }
  public invalidateAuthority(): void { this.invalidAuthority = true; this.failed = true; }
  public seal(): void { this.shuttingDown = true; }
  public async drain(): Promise<void> {
    await traceSpan("codex.mcp.invocation.drain", () => Promise.allSettled([...this.invocations.values()]));
    await this.progress.drain();
  }
  public beginAppend(): () => void {
    let complete!: () => void;
    const hold = new Promise<void>(resolve => { complete = resolve; });
    this.appendHolds.add(hold);
    let released = false;
    return () => { if (released) return; released = true; this.appendHolds.delete(hold); complete(); };
  }
  public appendRequest(request: ControllerMessageRequest): void {
    if (this.shuttingDown) throw new Error("Current turn no longer accepts new requests");
    if (request.chatId !== this.request.chatId) throw new Error("Cannot append another chat's request");
    const existing = this.requests.find(item => item.request.messageId === request.messageId);
    if (existing) {
      if (existing.request.text !== request.text) throw new Error("Conflicting appended request identity");
      return;
    }
    this.requests.push({ request: Object.freeze({ ...request }), submitted: false });
  }
  public close(): Promise<void> { return this.shutdown ??= this.shutdownServer(); }
  private async shutdownServer(): Promise<void> {
    this.seal();
    const cleanup = await Promise.allSettled([
      Promise.resolve().then(() => this.server.closeAllConnections()),
      new Promise<void>((resolve, reject) => { this.server.close(error => error ? reject(error) : resolve()); }),
      ...[...this.sessions].map(session => Promise.resolve().then(() => session.close())),
    ]);
    await this.drain();
    if (cleanup.some(result => result.status === "rejected")) throw new Error("Control tool shutdown failed");
  }
  /** The user text reaches the model once, as current_user_message or a result's currentRequest. */
  private listInstructions(listed: ControllerToolList): string {
    const context = contextText(listed);
    return listed.instructions + (context ? `\n${context}` : "");
  }
  private currentRequest(): ControllerMessageRequest {
    const pending = this.requests.filter(item => !item.submitted);
    return pending.length ? freezeRequestBatch(pending.map(item => item.request)) : this.batch?.request ?? this.request;
  }
  private selectBatch(request: ControllerMessageRequest): Batch {
    if (this.batch?.request === request) return this.batch;
    const pending = this.requests.filter(item => !item.submitted);
    if (!pending.length && this.batch) return this.batch;
    for (const item of pending) item.submitted = true;
    const previous = Promise.allSettled([...this.invocations.values()]);
    const batch: Batch = { items: pending, dispatched: false, released: false, request, ready: Promise.resolve(), toolNames: new Set(), instructions: "", mutationTail: Promise.resolve() };
    batch.ready = previous.then(async () => {
      if (this.invalidAuthority) throw new Error("Current request authority unavailable");
      const listed = request.messageId === this.request.messageId && request.text === this.request.text
        ? this.initialListing! : await this.controller.listTools(request);
      batch.toolNames = new Set(listed.tools.map(tool => tool.name));
      batch.instructions = this.listInstructions(listed);
    });
    this.batch = batch;
    return batch;
  }
  private authenticated(request: IncomingMessage): boolean {
    const supplied = Buffer.from(request.headers.authorization ?? ""), expected = Buffer.from(`Bearer ${this.token}`);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }
  private createSession(): Server {
    const session = new Server({ name: "wechat-current-request", version: "1.0.0" }, { capabilities: { tools: {} } });
    session.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...this.tools.map(tool => ({ ...structuredClone(tool),
      inputSchema: { ...structuredClone(tool.inputSchema), properties: { ...structuredClone(tool.inputSchema.properties),
        requestMessageId: { type: "string", description: "这次调用依据的用户消息 ID，第一次调用可以不填。用户追加消息后，换成工具返回的最新 ID，并按最新原文重新选参数。" } } } })), structuredClone(this.progressTool)] }));
    session.setRequestHandler(CallToolRequestSchema, input => this.callTool(input.params.name, input.params.arguments));
    return session;
  }
  private async callTool(name: string, wrapper?: Record<string, unknown>) {
    if (name === PROGRESS_TOOL_NAME) {
      if (this.shuttingDown || !validateProgressArguments(this.progressTool, wrapper)) throw new McpError(ErrorCode.InvalidParams, "Progress arguments do not match the active tool schema");
      return { content: [{ type: "text" as const, text: JSON.stringify(await this.progress.report(wrapper.text)) }] };
    }
    const tool = this.tools.find(tool => tool.name === name);
    if (this.shuttingDown || !tool || !wrapper || typeof wrapper.arguments !== "object" || wrapper.arguments === null ||
        Array.isArray(wrapper.arguments) || Object.keys(wrapper).some(key => !WRAPPER_KEYS.has(key)) ||
        (wrapper.requestMessageId !== undefined && typeof wrapper.requestMessageId !== "string")) throw new McpError(ErrorCode.InvalidParams, "Invalid current-request business tool");
    while (this.appendHolds.size) await Promise.all(this.appendHolds);
    if (this.invalidAuthority || this.shuttingDown) return toolError("本次调用未执行：追加消息是否已被本轮接受还没核实，当前请求授权待核实，不能再提交操作。之前已提交的操作结果待核对，不要说已完成，也不要再调一次。");
    const request = this.currentRequest();
    if (request.text.length > MAX_CONTROLLER_REQUEST_CHARS) return toolError("本次调用未执行：本轮待提交的用户消息合并后超出长度上限，这些消息都没有提交。不要截断原文或逐条执行，请用户发一条精简后的完整请求。");
    if ((wrapper.requestMessageId ?? this.request.messageId) !== request.messageId) return this.authorityChanged();
    const batch = this.selectBatch(request);
    const args = structuredClone(wrapper.arguments as Record<string, unknown>);
    const key = canonicalJson({ request: batch.request, name, arguments: args,
      ...(tool.annotations.readOnlyHint ? { readGeneration: this.readGeneration } : {}) });
    let invocation = this.invocations.get(key);
    if (!invocation) {
      const callId = createHash("sha256").update(key).digest("hex");
      const dependencies = tool.annotations.readOnlyHint ? batch.mutationTail : Promise.allSettled([...this.invocations.values()]);
      this.pending++;
      invocation = Promise.all([batch.ready, dependencies]).then(async () => {
        // A call can spend time behind another business invocation. Native steer
        // acceptance must be checked again at the actual dispatch boundary.
        while (this.appendHolds.size) await Promise.all(this.appendHolds);
        if (this.invalidAuthority) throw new Error("Current request authority unavailable");
        if (this.requests.at(-1)!.request.messageId !== batch.request.messageId) {
          if (!batch.dispatched && !batch.released) {
            batch.released = true;
            for (const item of batch.items) item.submitted = false;
          }
          throw new StaleAuthorityError();
        }
        if (!batch.toolNames.has(name)) throw new ControllerToolRejectedError(409);
        if (!tool.annotations.readOnlyHint && this.failed) throw new Error("Previous business call outcome is uncertain");
        if (ASSET_TOOLS.has(name) && this.assetMessageId && this.assetMessageId !== batch.request.messageId) throw new ReplyAssetSourceError();
        batch.dispatched = true;
        return traceSpan("codex.mcp.controller", () => this.controller.callTool({ ...batch.request, callId, name, arguments: args }));
      }).then(result => {
        const snapshot = structuredClone(result);
        const entries = [...this.responses.values(), { value: snapshot, messageId: batch.request.messageId }];
        const assetEntries = entries.filter(entry => entry.value.reply && (hasConsoleCredential(entry.value.reply.text) || entry.value.reply.images?.length));
        if (new Set(assetEntries.map(entry => entry.messageId)).size > 1) throw new Error("Conflicting reply asset sources");
        const replies = entries.flatMap(entry => entry.value.reply ? [entry.value.reply] : []);
        if (replies.filter(reply => hasConsoleCredential(reply.text)).length > 1) throw new Error("Multiple console replies cannot be recovered as one delivery");
        aggregateImages(replies);
        this.assetMessageId = assetEntries[0]?.messageId;
        this.responses.set(key, { value: snapshot, messageId: batch.request.messageId });
        return result;
      }).catch(error => {
        if (error instanceof ControllerToolRejectedError) this.rejections.add(key);
        else {
          this.failed = true;
          if (!tool.annotations.readOnlyHint) this.uncertainMutation = true;
        }
        throw error;
      }).finally(() => {
        this.pending--;
        if (!tool.annotations.readOnlyHint) this.readGeneration++;
      });
      this.invocations.set(key, invocation);
      if (!tool.annotations.readOnlyHint) batch.mutationTail = invocation.then(() => undefined, () => undefined);
    } else traceEvent("codex.mcp.invocation.reused");
    try {
      const result = await invocation;
      if (this.invalidAuthority) throw new Error("Current request authority unavailable");
      // The turn prompt already holds the first request and its instructions; only a later batch needs them again.
      const switched = batch.request.messageId !== this.request.messageId;
      return { content: [{ type: "text" as const, text: redactConsoleCredentials(JSON.stringify({ ...result,
        ...(switched ? { currentRequest: { messageId: batch.request.messageId, text: batch.request.text }, instructions: batch.instructions } : {}) })) }] };
    } catch (error) {
      if (error instanceof StaleAuthorityError) return this.authorityChanged();
      if (error instanceof ReplyAssetSourceError) return toolError("本次调用未执行：同一次回复里的图片和控制台链接必须来自同一条用户消息。之前准备好的图片和链接仍保留；告诉用户来源冲突，不要重试或换来源。");
      return controllerFailure(error);
    }
  }
  private async authorityChanged() {
    this.authorityCorrection = true;
    const request = this.currentRequest();
    const listed = request.text.length <= MAX_CONTROLLER_REQUEST_CHARS ? await this.controller.listTools(request) : undefined;
    return toolError("本次调用未执行：用户追加了消息。读完 currentRequest 里的最新原文，按最新要求重新选择工具和参数，requestMessageId 填 currentRequest.messageId。", {
      currentRequest: { messageId: request.messageId, text: redactConsoleCredentials(request.text) },
      ...(listed ? { instructions: this.listInstructions(listed) } : {}),
    });
  }
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.url !== "/mcp") { response.writeHead(404); response.end(); return; }
    if (!this.authenticated(request)) { response.writeHead(401); response.end(); return; }
    if (request.method !== "POST") { response.writeHead(405); response.end(); return; }
    let bytes = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > BODY_LIMIT) { response.writeHead(413); response.end(); return; }
      chunks.push(Buffer.from(chunk));
    }
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { response.writeHead(400); response.end(); return; }
    const session = this.createSession();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    this.sessions.add(session);
    let closing: Promise<void> | undefined;
    const close = () => closing ??= session.close().finally(() => this.sessions.delete(session));
    const disconnected = () => { void close().catch(() => response.destroy()); };
    response.once("close", disconnected);
    try { await session.connect(transport); await transport.handleRequest(request, response, body); }
    finally { response.removeListener("close", disconnected); await close(); }
  }
}
/** Passes the Controller's own reason and next step to the model; the generic text covers a missing reason. */
function controllerFailure(error: unknown) {
  if (error instanceof ControllerToolRejectedError) {
    return error.detail
      ? toolError(`本次调用未执行：${error.detail.message}此前成功的结果仍有效。`, { code: error.detail.code })
      : toolError(`本次调用未执行：Controller 拒绝了这次调用（HTTP ${error.httpStatus}）。此前成功的结果仍有效；告诉用户被拒绝，不要再调一次。`);
  }
  if (error instanceof ControllerToolFailedError && error.detail) {
    return toolError(`这次调用结果不明，可能已经执行：${error.detail.message}`, { code: error.detail.code });
  }
  return toolError(CONTROLLER_UNCERTAIN_TEXT);
}
function toolError(text: string, data: Record<string, unknown> = {}) {
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ text, ...data }) }] };
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function aggregateImages(replies: ControllerMessageResponse[]): ImageAttachment[] {
  const byId = new Map<string, ImageAttachment>();
  for (const reply of replies) for (const image of validateImageAttachments(reply.images ?? [])) {
    const previous = byId.get(image.id);
    if (previous && canonicalJson(previous) !== canonicalJson(image)) throw new Error("Conflicting image attachment metadata");
    byId.set(image.id, image);
  }
  return validateImageAttachments([...byId.values()]);
}
