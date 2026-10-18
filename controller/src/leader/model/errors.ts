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
const TRANSIENT_TRANSPORT_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
]);
const PERMANENT_TRANSPORT_CODES = new Set([
  "ENOTFOUND", "ERR_INVALID_URL", "ERR_INVALID_ARG_TYPE", "UND_ERR_INVALID_ARG",
  "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "SELF_SIGNED_CERT_IN_CHAIN", "ERR_SSL_WRONG_VERSION_NUMBER",
]);
const MAX_CAUSE_DEPTH = 5;
export type ModelTransportPhase = "fetch" | "response_body";

export interface ModelDiagnostic {
  category: ModelFailureCategory;
  httpStatus?: number;
  providerCode?: string;
  attempts?: number;
  causeCode?: string;
  transportPhase?: ModelTransportPhase;
}

export class ModelFailure extends Error {
  constructor(message: string, readonly diagnostic: ModelDiagnostic) {
    super(message);
    this.name = "ModelFailure";
  }
}

export class ModelTransportFailure extends ModelFailure {
  constructor(readonly retryable: boolean, diagnostic: ModelDiagnostic) {
    super(diagnostic.transportPhase === "response_body" ? "Model response stream read failed" : "Model transport request failed", diagnostic);
  }
}

/** Keep only known machine codes, never error messages, URLs, bodies, or the original cause. */
export function transportFailure(error: unknown, phase: ModelTransportPhase, attempts?: number): ModelTransportFailure {
  let cause: unknown = error;
  let causeCode: string | undefined;
  let hasMachineCode = false;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && cause && typeof cause === "object"; depth++) {
    if ("code" in cause && typeof cause.code === "string") {
      hasMachineCode = true;
      if (TRANSIENT_TRANSPORT_CODES.has(cause.code) || PERMANENT_TRANSPORT_CODES.has(cause.code)) {
        causeCode = cause.code;
        break;
      }
    }
    cause = "cause" in cause ? cause.cause : undefined;
  }
  // Native fetch sometimes supplies no cause code. Do not retry arbitrary TypeErrors (e.g. invalid headers).
  const nativeNetworkFailure = !hasMachineCode && error instanceof TypeError && ["fetch failed", "terminated", "Failed to fetch"].includes(error.message);
  return new ModelTransportFailure(causeCode ? TRANSIENT_TRANSPORT_CODES.has(causeCode) : nativeNetworkFailure, {
    category: "transport", transportPhase: phase, ...(causeCode ? { causeCode } : {}), ...(attempts ? { attempts } : {}),
  });
}

/** Only recognized codes leave the provider response; never copy its message, IDs, or body. */
export function providerErrorCode(body: string): string | undefined {
  try {
    const root: unknown = JSON.parse(body);
    if (!root || typeof root !== "object" || !("error" in root)) return undefined;
    const error = root.error;
    if (!error || typeof error !== "object") return undefined;
    const code = "code" in error && typeof error.code === "string" && PROVIDER_CODES.has(error.code) ? error.code : undefined;
    if (isQuotaError(code)) return code;
    if ("type" in error && typeof error.type === "string" && QUOTA_CODES.has(error.type)) return error.type;
    return code;
  } catch {
    return undefined; // An unstructured provider error body has no safe diagnostic code.
  }
}

export function isQuotaError(code?: string): boolean {
  return code !== undefined && QUOTA_CODES.has(code);
}

export function retryDelay(response: Response | undefined, baseMs: number, attempt: number): number {
  const retryAfter = response?.headers.get("retry-after");
  if (retryAfter != null && retryAfter.trim()) {
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
