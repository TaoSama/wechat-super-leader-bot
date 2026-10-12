import {
  ControlPlaneStatusResponse,
  HealthResponse,
  NodeStatus,
  ScopedSession,
  CommandRecord,
  CommandStatus,
  ActionType,
  AuthSessionResponse,
  AuthLogoutResponse,
  SessionHistory,
  HistoryItem,
} from "./types";
import { normalizeDesktopObservation } from "./session-observation";
import { normalizeSendAvailability } from "./send-availability";
import { HISTORY_CONTEXT_EXPIRED_MESSAGE, isHistoryContext, isSessionHistorySource } from "./history-contract";
import { isTerminalHistoryTarget } from "./terminal-session";
import { parseConsoleExecutions } from "./execution-contract";
import { parseConsoleGoals } from "./goal-contract";
import { normalizeInputReceipt, TERMINAL_SESSION_ID } from "./input-receipt";

export class ApiAuthError extends Error {
  public readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "ApiAuthError";
    this.statusCode = statusCode;
  }
}

export class ApiHttpError extends Error {
  public readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "ApiHttpError";
    this.statusCode = statusCode;
  }
}

export class ApiHistoryError extends ApiHttpError {
  constructor(statusCode: number, public readonly code: string | undefined, message: string) {
    super(statusCode, message);
    this.name = "ApiHistoryError";
  }
}

const HISTORY_ERROR_MESSAGES: Record<string, string> = {
  history_context_expired: HISTORY_CONTEXT_EXPIRED_MESSAGE,
  history_incomplete: "尚未取得完整历史，请稍后重试。",
  history_too_large: "历史超出读取大小限制。",
  history_invalid_request: "历史读取参数无效。",
  history_invalid_response: "历史响应格式无效。",
  history_unavailable: "当前历史读取接口不可用。",
  history_timeout: "历史读取超时，请重试。",
  history_busy: "历史读取繁忙，请稍后重试。",
  history_failed: "历史读取失败，请重试。",
  history_offline: "历史所在机器离线。",
  history_disconnected: "历史所在机器已断开连接。",
  history_session_not_found: "历史会话不存在。",
};
const MAX_HISTORY_ERROR_BODY_LENGTH = 4096;

async function historyHttpError(response: Response): Promise<ApiHistoryError> {
  const fallback = new ApiHistoryError(response.status, undefined, `历史读取未成功 (HTTP ${response.status})`);
  try {
    const body = await response.text();
    if (body.length > MAX_HISTORY_ERROR_BODY_LENGTH) return fallback;
    const value: unknown = JSON.parse(body);
    if (!value || typeof value !== "object") return fallback;
    const code = (value as Record<string, unknown>).code;
    if (typeof code !== "string" || !Object.hasOwn(HISTORY_ERROR_MESSAGES, code)) return fallback;
    return new ApiHistoryError(response.status, code, HISTORY_ERROR_MESSAGES[code]);
  } catch {
    return fallback;
  }
}

const VALID_COMMAND_STATUSES: ReadonlySet<CommandStatus> = new Set([
  "pending",
  "accepted",
  "input-written",
  "completed",
  "failed",
  "uncertain",
]);

function normalizeActionCapabilities(raw: unknown): ActionType[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const result: ActionType[] = [];
  for (const item of raw) {
    if ((item === "read" || item === "send") && !result.includes(item)) {
      result.push(item);
    }
  }
  return result;
}

function normalizeNode(raw: unknown): NodeStatus | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.nodeId !== "string" || obj.nodeId.trim() === "") return null;
  return {
    nodeId: obj.nodeId,
    connected: Boolean(obj.connected),
    lastHeartbeat:
      typeof obj.lastHeartbeat === "string" ? obj.lastHeartbeat : "",
    sessionCount:
      typeof obj.sessionCount === "number" && Number.isFinite(obj.sessionCount)
        ? obj.sessionCount
        : 0,
  };
}

function normalizeSession(raw: unknown): ScopedSession | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "string" || obj.id.trim() === "") return null;
  if (typeof obj.nodeId !== "string" || obj.nodeId.trim() === "") return null;
  const provider = typeof obj.provider === "string" && obj.provider ? obj.provider : "codex-app";

  // Malformed desktop evidence must not become "absent" and bypass its veto.
  const desktopObservation = normalizeDesktopObservation(obj.desktopObservation) ??
    (obj.desktopObservation !== undefined && obj.sendAvailability !== undefined
      ? { source: "codex-desktop" as const, status: "unknown" as const, availability: "unavailable" as const }
      : undefined);
  return {
    id: obj.id,
    nodeId: obj.nodeId,
    provider,
    title: typeof obj.title === "string" ? obj.title : "",
    cwd: typeof obj.cwd === "string" ? obj.cwd : "",
    status:
      typeof obj.status === "string" && obj.status.trim() !== ""
        ? obj.status
        : "unknown",
    capabilities: normalizeActionCapabilities(obj.capabilities),
    observedAt: typeof obj.observedAt === "string" ? obj.observedAt : "",
    model: typeof obj.model === "string" ? obj.model : undefined,
    modelProvider: typeof obj.modelProvider === "string" ? obj.modelProvider : undefined,
    reasoningEffort: typeof obj.reasoningEffort === "string" ? obj.reasoningEffort : undefined,
    updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : undefined,
    preview: typeof obj.preview === "string" ? obj.preview : undefined,
    loaded: typeof obj.loaded === "boolean" ? obj.loaded : undefined,
    desktopObservation,
    sendAvailability: normalizeSendAvailability(obj.sendAvailability),
    ...(obj.historySource === "terminal-transcript" && isTerminalHistoryTarget({ id: obj.id, provider })
      ? { historySource: "terminal-transcript" as const } : {}),
  };
}

const HISTORY_LIMIT = 30;
const REQUEST_TIMEOUT_MS = 20_000;

async function sessionRequest(url: string, init: RequestInit, historyErrors = false): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = window.setTimeout(abort, REQUEST_TIMEOUT_MS);
  if (init.signal?.aborted) abort();
  init.signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch(url, { ...init, credentials: "same-origin", signal: controller.signal });
    if (response.status === 401 || response.status === 403) {
      throw new ApiAuthError(response.status, "会话登录已失效，请重新获取微信登录链接");
    }
    if (!response.ok) {
      if (historyErrors) throw await historyHttpError(response);
      throw new ApiHttpError(response.status, `请求未成功 (HTTP ${response.status})`);
    }
    return await response.json();
  } finally {
    window.clearTimeout(timer);
    init.signal?.removeEventListener("abort", abort);
  }
}

function sessionPath(nodeId: string, sessionId: string): string {
  return `/v1/sessions/${encodeURIComponent(nodeId)}/${encodeURIComponent(sessionId)}`;
}

export async function fetchSessionHistory(nodeId: string, sessionId: string, cursor?: string, signal?: AbortSignal, historyContext?: string): Promise<SessionHistory> {
  if (historyContext !== undefined && !isHistoryContext(historyContext) || cursor && !historyContext) throw new Error("历史读取参数无效");
  const query = new URLSearchParams({ limit: String(HISTORY_LIMIT) });
  if (cursor) query.set("cursor", cursor);
  if (historyContext) query.set("historyContext", historyContext);
  const raw = await sessionRequest(`${sessionPath(nodeId, sessionId)}/history?${query}`, { method: "GET", headers: { Accept: "application/json" }, signal }, true);
  if (typeof raw !== "object" || raw === null) throw new Error("历史响应格式无效");
  const data = raw as Record<string, unknown>;
  if (!isHistoryContext(data.historyContext) || historyContext !== undefined && data.historyContext !== historyContext) throw new Error("历史响应与当前读取上下文不匹配");
  if (data.session && typeof data.session === "object" && "nodeId" in data.session && data.session.nodeId !== nodeId) throw new Error("历史响应与当前会话不匹配");
  const session = normalizeSession({ ...(typeof data.session === "object" ? data.session : {}), nodeId });
  if (!session || session.id !== sessionId || !Array.isArray(data.items) || typeof data.fetchedAt !== "string") throw new Error("历史响应与当前会话不匹配");
  if (!isSessionHistorySource(data.source, session)) throw new Error("历史响应与当前读取来源不匹配");
  const items = data.items.map((item: unknown): HistoryItem => {
    if (typeof item !== "object" || item === null) throw new Error("历史条目格式无效");
    const value = item as Record<string, unknown>;
    if (typeof value.id !== "string" || typeof value.text !== "string" || typeof value.turnId !== "string" || !["user", "assistant", "tool", "system"].includes(String(value.kind))) throw new Error("历史条目格式无效");
    if (data.source === "terminal-transcript" && ((value.kind !== "user" && value.kind !== "assistant") ||
        (value.type !== "transcript_message" && value.type !== "transcript_chunk"))) throw new Error("CLI 会话记录条目格式无效");
    return { id: value.id, text: value.text, turnId: value.turnId, kind: value.kind as HistoryItem["kind"], type: typeof value.type === "string" ? value.type : "unknown", title: typeof value.title === "string" ? value.title : undefined, status: typeof value.status === "string" ? value.status : undefined, timestamp: typeof value.timestamp === "string" ? value.timestamp : undefined, truncated: value.truncated === true };
  });
  return { session, historyContext: data.historyContext, source: data.source, items, nextCursor: typeof data.nextCursor === "string" ? data.nextCursor : null, fetchedAt: data.fetchedAt, truncated: data.truncated === true };
}

export async function sendSessionMessage(nodeId: string, sessionId: string, prompt: string, requestId: string, signal?: AbortSignal): Promise<CommandRecord> {
  const raw = await sessionRequest(`${sessionPath(nodeId, sessionId)}/messages`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", "X-Super-Leader-Intent": "session-message" }, body: JSON.stringify({ prompt, requestId }), signal });
  const command = normalizeCommand(raw);
  if (!command || command.nodeId !== nodeId || command.sessionId !== sessionId) throw new Error("发送回执与当前会话不匹配，需核查");
  return command;
}

export async function fetchCommand(commandId: string, signal?: AbortSignal): Promise<CommandRecord> {
  const command = normalizeCommand(await sessionRequest(`/v1/commands/${encodeURIComponent(commandId)}`, { method: "GET", headers: { Accept: "application/json" }, signal }));
  if (!command || command.commandId !== commandId) throw new Error("命令回执格式无效");
  return command;
}

function normalizeCommand(raw: unknown): CommandRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.commandId !== "string" || obj.commandId.trim() === "") return null;
  if (typeof obj.nodeId !== "string" || obj.nodeId.trim() === "") return null;
  if (typeof obj.sessionId !== "string" || obj.sessionId.trim() === "") return null;

  const rawStatus = obj.status as CommandStatus;
  const status: CommandStatus = VALID_COMMAND_STATUSES.has(rawStatus)
    ? rawStatus
    : "uncertain";

  const action: ActionType = obj.action === "send" ? "send" : "read";
  const inputReceipt = normalizeInputReceipt(obj.inputReceipt);
  const terminalSend = action === "send" && (obj.sendRoute === "terminal-pane" || obj.sessionId.startsWith("terminal:"));
  if (terminalSend) {
    if (obj.sendRoute !== "terminal-pane" || !TERMINAL_SESSION_ID.test(obj.sessionId) ||
        !["pending", "input-written", "failed", "uncertain"].includes(status) || obj.turnId !== undefined ||
        obj.output !== undefined && obj.output !== "") return null;
    if (status === "input-written") {
      if (!inputReceipt || inputReceipt.sessionId !== obj.sessionId || obj.error !== undefined) return null;
    } else if (obj.inputReceipt !== undefined) return null;
  } else if (status === "input-written" || obj.inputReceipt !== undefined || action === "read" && obj.sendRoute !== undefined) return null;

  return {
    commandId: obj.commandId,
    requestId: typeof obj.requestId === "string" ? obj.requestId : "",
    nodeId: obj.nodeId,
    sessionId: obj.sessionId,
    action,
    prompt: typeof obj.prompt === "string" ? obj.prompt : undefined,
    status,
    output: typeof obj.output === "string" ? obj.output : undefined,
    error: typeof obj.error === "string" ? obj.error : undefined,
    turnId: typeof obj.turnId === "string" ? obj.turnId : undefined,
    sendRoute: obj.sendRoute === "desktop-owner" || obj.sendRoute === "control-socket" || obj.sendRoute === "terminal-pane" ? obj.sendRoute : undefined,
    inputReceipt,
    expiresAt: typeof obj.expiresAt === "string" ? obj.expiresAt : "",
    createdAt: typeof obj.createdAt === "string" ? obj.createdAt : "",
    updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : "",
  };
}

/**
 * Exchanges a one-time token for an HttpOnly session cookie.
 * POST /auth/exchange
 * Body: { token }
 * Headers: Content-Type: application/json
 * Credentials: same-origin
 */
export async function exchangeLoginToken(
  token: string,
  signal?: AbortSignal
): Promise<AuthSessionResponse> {
  const cleanToken = token.trim();
  if (!cleanToken) {
    throw new ApiAuthError(401, "未提供一次性登录凭证");
  }

 const response = await fetch("/auth/exchange", {
   method: "POST",
   headers: {
     "Content-Type": "application/json",
     Accept: "application/json",
   },
   credentials: "same-origin",
   body: JSON.stringify({ token: cleanToken }),
   signal,
 });

 if (response.status === 401 || response.status === 403) {
    throw new ApiAuthError(
      response.status,
      "登录凭证无效或已过期，请在微信中重新获取登录链接"
    );
 }

 if (!response.ok) {
   throw new ApiHttpError(response.status, `兑换会话失败 (HTTP ${response.status})`);
 }

  const data = (await response.json()) as Record<string, unknown>;
  return {
    authenticated: Boolean(data.authenticated),
    expiresAt: typeof data.expiresAt === "string" ? data.expiresAt : undefined,
  };
}

/**
 * Verifies current browser session via HttpOnly cookie.
 * GET /auth/session
 * Credentials: same-origin
 */
export async function fetchAuthSession(
  signal?: AbortSignal
): Promise<AuthSessionResponse> {
  const response = await fetch("/auth/session", {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
    credentials: "same-origin",
    signal,
  });

  if (response.status === 401 || response.status === 403) {
    throw new ApiAuthError(response.status, "会话未登录或已过期");
  }

  if (!response.ok) {
    throw new ApiHttpError(response.status, `检查会话失败 (HTTP ${response.status})`);
  }

  const data = (await response.json()) as Record<string, unknown>;
  return {
    authenticated: Boolean(data.authenticated),
    expiresAt: typeof data.expiresAt === "string" ? data.expiresAt : undefined,
  };
}

/**
 * Revokes current session and clears HttpOnly session cookie.
 * POST /auth/logout
 * Credentials: same-origin
 */
export async function logoutAuthSession(
  signal?: AbortSignal
): Promise<AuthLogoutResponse> {
 const response = await fetch("/auth/logout", {
   method: "POST",
   headers: {
     "Content-Type": "application/json",
     Accept: "application/json",
   },
   credentials: "same-origin",
   signal,
 });

  if (!response.ok) {
   throw new ApiHttpError(response.status, `退出会话失败 (HTTP ${response.status})`);
 }

 return { authenticated: false };
}

/**
 * Strictly read-only GET /v1/status call relying on same-origin session cookie.
 * Zero Bearer tokens in the browser.
 */
export async function fetchControlPlaneStatus(
  signal?: AbortSignal
): Promise<ControlPlaneStatusResponse> {
 const response = await fetch("/v1/status", {
   method: "GET",
   headers: {
     Accept: "application/json",
   },
   credentials: "same-origin",
   signal,
 });

 if (response.status === 401 || response.status === 403) {
    const errMsg =
      response.status === 401
        ? "会话未认证或已过期 (401)"
        : "访问被拒绝 (403)";
   throw new ApiAuthError(response.status, errMsg);
 }

 if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body && typeof body.error === "string") {
        detail = `HTTP ${response.status}: ${body.error}`;
      }
    } catch {
      // Ignore non-JSON body
    }
    throw new ApiHttpError(
      response.status,
      `获取控制平面状态失败 (${detail})`
    );
  }

  return normalizeControlPlaneStatus(await response.json());
}

export function normalizeControlPlaneStatus(raw: unknown): ControlPlaneStatusResponse {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("控制平面状态格式无效");
  }
  const data = raw as Record<string, unknown>;
  if (!Array.isArray(data.nodes) || !Array.isArray(data.sessions) || !Array.isArray(data.commands)) {
    throw new Error("控制平面状态格式无效");
  }
  const nodes = Array.isArray(data.nodes)
    ? data.nodes
        .map(normalizeNode)
        .filter((n): n is NodeStatus => n !== null)
    : [];

  const sessions = Array.isArray(data.sessions)
    ? data.sessions
        .map(normalizeSession)
        .filter((s): s is ScopedSession => s !== null)
    : [];

  const commands = Array.isArray(data.commands)
    ? data.commands
        .map(normalizeCommand)
        .filter((c): c is CommandRecord => c !== null)
    : [];

  const leaderMode = data.leaderMode === "rules" || data.leaderMode === "model" ? data.leaderMode : "unknown";
  const leaderModel = typeof data.leaderModel === "string" && data.leaderModel.trim() ? data.leaderModel : undefined;
  return { nodes, sessions, commands, leaderMode, leaderModel, executions: parseConsoleExecutions(data.executions), goals: parseConsoleGoals(data.goals) };
}

/**
 * Public liveness probe GET /health
 */
export async function fetchControllerHealth(
  signal?: AbortSignal
): Promise<HealthResponse> {
  const response = await fetch("/health", {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
    signal,
  });

  if (!response.ok) {
    throw new ApiHttpError(
      response.status,
      `健康检查返回异常状态 HTTP ${response.status}`
    );
  }

  const data = (await response.json()) as Record<string, unknown>;
  return {
    status: typeof data.status === "string" ? data.status : "unknown",
    timestamp: typeof data.timestamp === "string" ? data.timestamp : "",
  };
}
