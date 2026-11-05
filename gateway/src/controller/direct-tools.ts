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
export interface ControllerToolCall extends ControllerMessageRequest {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
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
const REJECTED_CODE = "DIRECT_TOOL_REJECTED";
const MAX_FAILURE_MESSAGE_CHARS = 600;
/** The Controller's reason, written for the leader model. */
export interface ControllerFailureDetail { code: string; message: string }
/** An explicit server guarantee that this business invocation did not start. */
export class ControllerToolRejectedError extends Error {
  constructor(public readonly httpStatus: number, public readonly detail?: ControllerFailureDetail) {
    super(`Controller rejected tool without executing it (HTTP ${httpStatus})`);
    this.name = "ControllerToolRejectedError";
  }
}
/** The Controller answered with an error whose business effect may already have happened. */
export class ControllerToolFailedError extends Error {
  constructor(public readonly httpStatus: number, public readonly detail?: ControllerFailureDetail) {
    super(`Controller tool returned HTTP ${httpStatus}`);
    this.name = "ControllerToolFailedError";
  }
}
// A Controller from the previous release still requires the retired attestation and rejects every mutation
// without it. Its body has no message, so name the cause for the model. Remove with the attestation fallback.
const LEGACY_AUTHORIZATION_REJECTION = "Current-turn authorization does not permit this operation";
const LEGACY_CONTROLLER_DETAIL: ControllerFailureDetail = { code: "CONTROLLER_UPGRADING",
  message: "Controller 正在升级，这次操作没有执行。告诉用户系统正在升级，请稍后再发一次，不要现在重试。" };
function failureDetail(body: Record<string, unknown>): ControllerFailureDetail | undefined {
  if (body.code === REJECTED_CODE && body.error === LEGACY_AUTHORIZATION_REJECTION && body.message === undefined) return LEGACY_CONTROLLER_DETAIL;
  const code = typeof body.reason === "string" ? body.reason : body.code;
  if (typeof code !== "string" || typeof body.message !== "string" || !body.message.trim()) return undefined;
  return { code, message: body.message.slice(0, MAX_FAILURE_MESSAGE_CHARS) };
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
        if (endpoint !== "/v1/tools/call" || response.status === 401) throw new Error(`Controller tool returned HTTP ${response.status}`);
        let failure: unknown;
        try { failure = await beforeAbort(response.json(), abort.signal); }
        catch { abort.signal.throwIfAborted(); throw new ControllerToolFailedError(response.status); }
        const body = failure && typeof failure === "object" ? failure as Record<string, unknown> : {};
        const detail = failureDetail(body);
        // A bare 4xx may follow a partially executed action. Only the explicit
        // server guarantee permits retaining prior successful business receipts.
        if (response.status >= 400 && response.status < 500 && body.code === REJECTED_CODE && body.execution === "not_started") {
          throw new ControllerToolRejectedError(response.status, detail);
        }
        throw new ControllerToolFailedError(response.status, detail);
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
