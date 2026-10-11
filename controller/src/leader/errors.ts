export type ModelFailureCategory = "timeout" | "transport" | "http" | "invalid_response" | "processing";

const PROVIDER_CODES = new Set([
  "server_error", "server_is_overloaded", "slow_down", "rate_limit_exceeded", "insufficient_quota",
  "credit_balance_exhausted", "organization_spend_limit_exceeded", "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded", "invalid_api_key", "model_not_found",
]);
const QUOTA_CODES = new Set([
  "insufficient_quota", "credit_balance_exhausted", "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded", "organization_usage_limit_exceeded",
]);

export interface ModelDiagnostic {
  category: ModelFailureCategory;
  httpStatus?: number;
  providerCode?: string;
  attempts?: number;
}

export class ModelFailure extends Error {
  constructor(message: string, readonly diagnostic: ModelDiagnostic) {
    super(message);
    this.name = "ModelFailure";
  }
}

/** Only recognized codes leave the provider response; never copy its message, IDs, or body. */
export function providerErrorCode(body: string): string | undefined {
  try {
    const root: unknown = JSON.parse(body);
    if (!root || typeof root !== "object" || !("error" in root)) return undefined;
    const error = root.error;
    if (!error || typeof error !== "object" || !("code" in error)) return undefined;
    return typeof error.code === "string" && PROVIDER_CODES.has(error.code) ? error.code : undefined;
  } catch {
    return undefined; // An unstructured provider error body has no safe diagnostic code.
  }
}

export function isQuotaError(code?: string): boolean {
  return code !== undefined && QUOTA_CODES.has(code);
}

export function retryDelay(response: Response, baseMs: number, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter !== null && retryAfter.trim()) {
    const seconds = Number(retryAfter);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return baseMs * 2 ** attempt + Math.floor(Math.random() * baseMs);
}

export function modelDiagnostic(error: unknown): ModelDiagnostic {
  if (error instanceof ModelFailure) return error.diagnostic;
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return { category: "timeout" };
  }
  return { category: "processing" };
}

export function failureReply(error: unknown, reference: string): string {
  const diagnostic = modelDiagnostic(error);
  let detail = "本次模型处理未成功：处理遇到异常，未能确认查询结果";
  if (diagnostic.category === "timeout") detail = "本次查询处理超时，未能确认当前任务状态；请稍后重新查询";
  else if (diagnostic.category === "transport" ||
    (diagnostic.category === "http" && diagnostic.httpStatus !== undefined &&
      [429, 500, 502, 503, 504].includes(diagnostic.httpStatus) && !isQuotaError(diagnostic.providerCode))) {
    detail = `模型服务暂时不可用${(diagnostic.attempts ?? 1) > 1 ? "，安全重试后仍未恢复" : ""}；请稍后重新查询`;
  } else if (diagnostic.category === "http" && diagnostic.httpStatus !== undefined &&
    ([400, 401, 403, 404].includes(diagnostic.httpStatus) || isQuotaError(diagnostic.providerCode))) {
    detail = "模型服务配置或额度异常，需要检查服务配置";
  } else if (diagnostic.category === "invalid_response") detail = "模型返回了不完整或无效的结果，未能确认查询结果；请稍后重新查询";
  return `${detail}。未向会话发送新指令。参考编号：${reference}`;
}
