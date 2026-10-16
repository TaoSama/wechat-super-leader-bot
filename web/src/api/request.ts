import { ApiAuthError, ApiHttpError, historyHttpError } from "./errors";

const REQUEST_TIMEOUT_MS = 20_000;

export async function sessionRequest(url: string, init: RequestInit, historyErrors = false): Promise<unknown> {
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
