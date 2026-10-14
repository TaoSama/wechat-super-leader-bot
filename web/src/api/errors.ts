import { HISTORY_CONTEXT_EXPIRED_MESSAGE } from "../features/sessions/history-contract";

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

export async function historyHttpError(response: Response): Promise<ApiHistoryError> {
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
