import { AuthSessionResponse, AuthLogoutResponse } from "../types";
import { ApiAuthError, ApiHttpError } from "./errors";

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
