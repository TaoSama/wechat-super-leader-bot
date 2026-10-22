import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { ControllerClient } from "../controller/client.js";
import type { ControllerMessageRequest, ControllerMessageResponse } from "../types.js";
import { currentTrace, runWithTrace, traceEvent, traceSpan } from "../runtime/telemetry.js";
import { MAX_PROGRESS_CHARS, QueryProgress, type ProgressSink } from "./progress.js";

const BODY_LIMIT = 16 * 1024;
const MAX_CONTROLLER_REQUEST_CHARS = 16000;
const TOOL_NAME = "control_current_request";
const PROGRESS_TOOL_NAME = "report_progress";
export const CONTROL_TOKEN_ENV = "LEADER_TURN_MCP_TOKEN";

export function hasConsoleCredential(text: string): boolean {
  return /#login=[A-Za-z0-9_.~%-]+/.test(text);
}

export function redactConsoleCredentials(text: string): string {
  return text.replace(/#login=[A-Za-z0-9_.~%-]+/g, "#login=[REDACTED]");
}

function freezeRequestBatch(requests: readonly ControllerMessageRequest[]): ControllerMessageRequest {
  const latest = requests[requests.length - 1];
  if (requests.length === 1) return latest;
  const text = "以下是同一轮请求中尚未提交执行的用户原始消息，按接收时间从早到晚排列。请先整体理解所有消息，再执行一次当前意图；后面的消息对前面的修改、限制或撤销优先，不能先执行已被后文替换或禁止的操作。所有消息原文如下：\n\n" +
    requests.map((request, index) => `【原始消息 ${index + 1}，messageId=${JSON.stringify(request.messageId)}】\n${request.text}`).join("\n\n");
  return Object.freeze({ chatId: latest.chatId, messageId: latest.messageId, text });
}

/** Authority is limited to the immutable original messages accepted into this turn. */
export class ControlMcp {
  public readonly token = randomBytes(32).toString("hex");
  public url = "";
  private response?: ControllerMessageResponse;
  private responseMessageId?: string;
  private invocation?: Promise<ControllerMessageResponse>;
  private readonly requests: { request: ControllerMessageRequest; submitted: boolean }[] = [];
  private readonly responses = new Map<string, ControllerMessageResponse>();
  private readonly appendHolds = new Set<Promise<void>>();
  private readonly progress: QueryProgress;
  private uncertain = false;
  private invalidAuthority = false;
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

  constructor(private readonly request: ControllerMessageRequest,
    private readonly controller: Pick<ControllerClient, "forwardMessage">,
    options: { progress?: ProgressSink } = {}) {
    // Capture only primitives so callers cannot mutate the tool's authority later.
    this.request = Object.freeze({ ...request });
    this.requests.push({ request: this.request, submitted: false });
    this.progress = new QueryProgress(this.request, options.progress);
    this.server.requestTimeout = 320000;
    this.server.headersTimeout = 10000;
  }

  public async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.removeListener("error", reject);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Control tool unavailable");
    this.url = `http://127.0.0.1:${address.port}/mcp`;
  }

  public get result(): ControllerMessageResponse | undefined { return this.uncertain ? undefined : this.response; }
  public get resultMessageId(): string | undefined { return this.result ? this.responseMessageId : undefined; }
  public get wasCalled(): boolean { return this.invocation !== undefined; }
  public get requestCount(): number { return this.requests.length; }

  public invalidateAuthority(): void {
    this.invalidAuthority = true;
    this.uncertain = true;
  }

  /** Hold tool authority while native steer acceptance is being established. */
  public beginAppend(): () => void {
    let complete!: () => void;
    const hold = new Promise<void>(resolve => { complete = resolve; });
    this.appendHolds.add(hold);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.appendHolds.delete(hold);
      complete();
    };
  }

  public appendRequest(request: ControllerMessageRequest): void {
    if (request.chatId !== this.request.chatId) throw new Error("Cannot append another chat's request");
    const existing = this.requests.find(item => item.request.messageId === request.messageId);
    if (existing) {
      if (existing.request.text !== request.text) throw new Error("Conflicting appended request identity");
      return;
    }
    this.requests.push({ request: Object.freeze({ ...request }), submitted: false });
  }

  public close(): Promise<void> {
    return this.shutdown ??= this.shutdownServer();
  }

  private async shutdownServer(): Promise<void> {
    const cleanup = await Promise.allSettled([
      Promise.resolve().then(() => this.server.closeAllConnections()),
      new Promise<void>((resolve, reject) => {
        this.server.close(error => error ? reject(error) : resolve());
      }),
      ...[...this.sessions].map(session => Promise.resolve().then(() => session.close())),
    ]);
    // A disconnected MCP caller does not cancel an already-submitted command.
    // Keep the per-chat turn lock until that command has a terminal result.
    if (this.invocation) {
      try { await traceSpan("codex.mcp.invocation.drain", () => this.invocation!); }
      catch {
        // A called tool without a result is an explicit uncertain outcome. The
        // engine keeps its journal started and returns a recovery instruction.
        this.response = undefined;
      }
    }
    await this.progress.drain();
    // Cleanup failures must not release the turn before a submitted command has
    // settled. Report only a sanitized error after draining every obligation.
    if (cleanup.some(result => result.status === "rejected")) throw new Error("Control tool shutdown failed");
  }

  private authenticated(request: IncomingMessage): boolean {
    const supplied = Buffer.from(request.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${this.token}`);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }

  private createSession(): Server {
    const session = new Server({ name: "wechat-current-request", version: "1.0.0" }, { capabilities: { tools: {} } });
    session.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: TOOL_NAME,
      description: "将本轮尚未提交的微信用户原文一起交给 Controller 查询或控制项目、机器和会话，包含本轮追加的新消息；先整体理解，最新修改或限制优先。无需也不能传入改写后的指令；每条原文只包含在一个提交批次中，新增消息到达后可再次调用。已提交的操作不能自动撤销，需核实实际结果并如实说明。普通聊天和维护本地记忆无需调用。",
      inputSchema: { type: "object", properties: {}, additionalProperties: false } }, {
      name: PROGRESS_TOOL_NAME,
      description: "在本轮处理耗时较长、已有值得告知的真实进展或需要说明等待原因时，向微信用户发送一条中间进度。用你自己的话写简短、具体、有证据的进展；不要凑数、空泛安抚或把已派发说成已完成。普通聊天也可用；每个根 query 最多 3 次，追加消息不重置额度。返回 sent、status、used、remaining、limit；失败或未知不重发，发送后继续完成工作并给最终回复。",
      inputSchema: { type: "object", properties: { text: { type: "string", minLength: 1, maxLength: MAX_PROGRESS_CHARS } },
        required: ["text"], additionalProperties: false } }] }));
    session.setRequestHandler(CallToolRequestSchema, async input => {
      if (input.params.name === PROGRESS_TOOL_NAME) {
        const args = input.params.arguments;
        if (!args || Object.keys(args).length !== 1 || typeof args.text !== "string" || !args.text.trim() ||
            args.text.length > MAX_PROGRESS_CHARS) throw new McpError(ErrorCode.InvalidParams, "Progress requires a non-empty text within the limit");
        const result = await this.progress.report(args.text);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }
      if (input.params.name !== TOOL_NAME || (input.params.arguments !== undefined &&
        Object.keys(input.params.arguments).length !== 0)) {
        throw new McpError(ErrorCode.InvalidParams, "This tool accepts no arguments");
      }
      // Native Codex can invoke this HTTP tool before its steer RPC response is
      // delivered. Wait for acceptance and append to become one authority change.
      // Recheck directly here so no microtask can insert a hold after the check
      // but before the synchronous request selection.
      while (this.appendHolds.size) await Promise.all(this.appendHolds);
      if (this.invalidAuthority) return {
        isError: true,
        content: [{ type: "text", text: "追加消息是否已被本轮接受尚未核实，当前请求授权待核实，不能继续提交操作。已提交的操作仍需核对实际结果；不要声称已完成或自行重试。" }],
      };
      const pending = this.requests.filter(item => !item.submitted);
      if (pending.length) {
        const batch = freezeRequestBatch(pending.map(item => item.request));
        if (batch.text.length > MAX_CONTROLLER_REQUEST_CHARS) return {
          isError: true,
          content: [{ type: "text", text: "本轮待提交的完整用户原文合并后超出 Controller 长度上限，这些消息均未提交执行。请向用户说明，并请其在新一轮发送精简后的完整请求；不能截断原文或逐条执行旧指令。" }],
        };
        for (const item of pending) item.submitted = true;
        const submit = async () => {
          try {
            const result = await traceSpan("codex.mcp.controller", () => this.progress.withController((remaining, report) => {
              // A queued batch may outlive an ambiguous native steer. Preserve
              // already-submitted obligations, but issue no new stale authority.
              if (this.invalidAuthority) throw new Error("Current request authority unavailable");
              return this.controller.forwardMessage(batch, { onProgress: async text => report(text), progressRemaining: remaining });
            }));
            this.response = result;
            this.responseMessageId = batch.messageId;
            this.responses.set(batch.messageId, result);
            return result;
          } catch {
            this.uncertain = true;
            throw new Error("Controller outcome unavailable");
          }
        };
        this.invocation = this.invocation ? this.invocation.then(submit, submit) : submit();
      } else {
        traceEvent("codex.mcp.invocation.reused");
      }
      try {
        const result = await this.invocation!;
        if (this.invalidAuthority) throw new Error("Current request authority unavailable");
        // One-time console credentials belong only on the WeChat delivery path,
        // never in Codex's persistent transcript or model context.
        const redact = (reply: ControllerMessageResponse) => ({ ...reply, text: redactConsoleCredentials(reply.text) });
        const visible = { ...redact(result), ...(this.requests.length > 1 ? {
          responses: this.requests.flatMap(item => {
            const reply = this.responses.get(item.request.messageId);
            return reply ? [{ messageId: item.request.messageId, reply: redact(reply) }] : [];
          }),
        } : {}) };
        return { content: [{ type: "text", text: JSON.stringify(visible) }] };
      } catch {
        return { isError: true, content: [{ type: "text", text: "Controller 调用未成功，执行结果待核实；请勿声称已完成，也不要自行重试。" }] };
      }
    });
    return session;
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
    try {
      await session.connect(transport);
      await transport.handleRequest(request, response, body);
    } finally {
      response.removeListener("close", disconnected);
      await close();
    }
  }
}
