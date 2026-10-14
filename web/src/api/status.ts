import { ControlPlaneStatusResponse, HealthResponse } from "../types";
import { ApiAuthError, ApiHttpError } from "./errors";
import { normalizeControlPlaneStatus } from "./normalizers";

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
