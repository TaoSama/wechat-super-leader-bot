import type { ControllerMessageRequest, ControllerMessageResponse } from "../types.js";
import type { FetchLike } from "../wechat/client.js";
import { beforeAbort } from "../runtime/abort.js";
import { currentTrace } from "../runtime/telemetry.js";
import { parseControllerReply } from "./reply-client.js";
import { parseControllerContext, type ControllerChatContext } from "./direct-context.js";

export interface ControllerTool {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties?: Record<string, unknown>; [key: string]: unknown };
  annotations: { readOnlyHint: boolean };
}
export interface ToolAuthorization {
  intent: "task" | "goal" | "preview" | "query" | "isolated_background" | "unclear";
  automationOperations?: ("create" | "pause" | "resume" | "cancel")[];
  backgroundOperations?: ("create" | "follow_up" | "extend")[];
  sendImages?: boolean;
  memoryOperations?: ("remember" | "forget")[];
}
export interface ControllerToolCall extends ControllerMessageRequest {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
  authorization?: ToolAuthorization;
}
export interface ControllerToolResult {
  result: unknown;
  reply?: ControllerMessageResponse;
}
export interface ControllerToolList { tools: ControllerTool[]; instructions: string; context?: ControllerChatContext }
export interface DirectToolClient {
  listTools(request: ControllerMessageRequest): Promise<ControllerToolList>;
  callTool(request: ControllerToolCall): Promise<ControllerToolResult>;
}
/** An explicit server guarantee that this business invocation did not start. */
export class ControllerToolRejectedError extends Error {
  constructor(public readonly httpStatus: number) {
    super(`Controller rejected tool without executing it (HTTP ${httpStatus})`);
    this.name = "ControllerToolRejectedError";
  }
}
interface Options { baseUrl: string; token: string; fetchImpl: FetchLike; timeoutMs: number }

export class ControllerDirectTools implements DirectToolClient {
  constructor(private readonly options: Options) {}

  private async post(endpoint: string, request: unknown): Promise<unknown> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error("Controller tool timed out")), this.options.timeoutMs);
    try {
      const response = await beforeAbort(this.options.fetchImpl(`${this.options.baseUrl}${endpoint}`, {
        method: "POST", redirect: "error", signal: abort.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.options.token}`,
          ...(currentTrace() ? { "X-Latency-Attempt": currentTrace()!.attemptId } : {}) },
        body: JSON.stringify(request),
      }), abort.signal);
      if (!response.ok) {
        // A bare 4xx may follow a partially executed action. Only the explicit
        // server guarantee permits retaining prior successful business receipts.
        if (endpoint === "/v1/tools/call" && response.status >= 400 && response.status < 500 &&
            response.status !== 401) {
          let failure: unknown;
          try { failure = await beforeAbort(response.json(), abort.signal); }
          catch { abort.signal.throwIfAborted(); throw new Error(`Controller tool returned HTTP ${response.status}`); }
          if (failure && typeof failure === "object" &&
              (failure as Record<string, unknown>).code === "DIRECT_TOOL_REJECTED" &&
              (failure as Record<string, unknown>).execution === "not_started") {
            throw new ControllerToolRejectedError(response.status);
          }
        }
        throw new Error(`Controller tool returned HTTP ${response.status}`);
      }
      const result: unknown = await beforeAbort(response.json(), abort.signal);
      abort.signal.throwIfAborted();
      return result;
    } finally { clearTimeout(timer); abort.abort(); }
  }

  public async listTools(request: ControllerMessageRequest): Promise<ControllerToolList> {
    const data = await this.post("/v1/tools/list", request);
    if (!data || typeof data !== "object" || !Array.isArray((data as { tools?: unknown }).tools) ||
        typeof (data as { instructions?: unknown }).instructions !== "string") {
      throw new Error("Controller tool list returned invalid response schema");
    }
    const tools = (data as { tools: unknown[] }).tools;
    const names = new Set<string>();
    for (const value of tools) {
      const tool = value as Partial<ControllerTool> | null;
      if (!tool || typeof tool.name !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(tool.name) || names.has(tool.name) ||
          typeof tool.description !== "string" || !tool.inputSchema || tool.inputSchema.type !== "object" ||
          !tool.annotations || typeof tool.annotations.readOnlyHint !== "boolean") {
        throw new Error("Controller tool list returned invalid response schema");
      }
      names.add(tool.name);
    }
    return { tools: tools as ControllerTool[], instructions: (data as ControllerToolList).instructions,
      context: parseControllerContext((data as Record<string, unknown>).context) };
  }

  public async callTool(request: ControllerToolCall): Promise<ControllerToolResult> {
    // A transport timeout leaves execution uncertain. Never resubmit a mutation here.
    const data = await this.post("/v1/tools/call", request);
    if (!data || typeof data !== "object" || !Object.hasOwn(data, "result")) {
      throw new Error("Controller tool call returned invalid response schema");
    }
    const record = data as Record<string, unknown>;
    return { result: record.result,
      ...(record.reply === undefined ? {} : { reply: parseControllerReply(record.reply, "/v1/tools/call") }) };
  }
}
