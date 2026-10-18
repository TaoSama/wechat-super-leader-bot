import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { ControllerClient } from "../controller/client.js";
import type { ControllerMessageRequest, ControllerMessageResponse } from "../types.js";

const BODY_LIMIT = 16 * 1024;
const TOOL_NAME = "control_current_request";
export const CONTROL_TOKEN_ENV = "LEADER_TURN_MCP_TOKEN";

export function hasConsoleCredential(text: string): boolean {
  return /#login=[A-Za-z0-9_.~%-]+/.test(text);
}

/** A capability for exactly the current, immutable WeChat request. */
export class ControlMcp {
  public readonly token = randomBytes(32).toString("hex");
  public url = "";
  private response?: ControllerMessageResponse;
  private invocation?: Promise<ControllerMessageResponse>;
  private shutdown?: Promise<void>;
  private readonly sessions = new Set<Server>();
  private readonly server = createServer((request, response) => {
    void this.handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });

  constructor(private readonly request: ControllerMessageRequest,
    private readonly controller: Pick<ControllerClient, "forwardMessage">) {
    // Capture only primitives so callers cannot mutate the tool's authority later.
    this.request = Object.freeze({ ...request });
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

  public get result(): ControllerMessageResponse | undefined { return this.response; }
  public get wasCalled(): boolean { return this.invocation !== undefined; }

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
      try { await this.invocation; }
      catch {
        // A called tool without a result is an explicit uncertain outcome. The
        // engine keeps its journal started and returns a recovery instruction.
        this.response = undefined;
      }
    }
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
      description: "将本轮微信用户原文交给 Controller 查询或控制项目、机器和会话。无需也不能传入改写后的指令；同一轮重复调用只提交一次。普通聊天和维护本地记忆无需调用。",
      inputSchema: { type: "object", properties: {}, additionalProperties: false } }] }));
    session.setRequestHandler(CallToolRequestSchema, async input => {
      if (input.params.name !== TOOL_NAME || (input.params.arguments !== undefined &&
        Object.keys(input.params.arguments).length !== 0)) {
        throw new McpError(ErrorCode.InvalidParams, "This tool accepts no arguments");
      }
      if (!this.invocation) {
        this.invocation = Promise.resolve().then(() => this.controller.forwardMessage(this.request))
          .then(result => { this.response = result; return result; });
      }
      try {
        const result = await this.invocation;
        // One-time console credentials belong only on the WeChat delivery path,
        // never in Codex's persistent transcript or model context.
        const visible = { ...result, text: result.text.replace(/#login=[A-Za-z0-9_.~%-]+/g, "#login=[REDACTED]") };
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
