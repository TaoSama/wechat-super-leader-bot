import { readBoundedStream } from "../leader/model/transport.js";

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const PUBLIC_STATUSES = new Set([400, 403, 404, 409, 503]);

export class SettingsHttpError extends Error {
  constructor(public readonly statusCode: number, message: string, public readonly code = "SETTINGS_UNAVAILABLE") {
    super(message);
  }
}

/** The destination is deployment configuration; browser inputs select only named resources. */
export class GatewaySettingsClient {
  constructor(private readonly origin: string | undefined, private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch) {}

  async request(path: string, method = "GET", body?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Record<string, unknown>> {
    if (!this.origin) throw new SettingsHttpError(503, "微信助手设置服务未配置", "GATEWAY_SETTINGS_UNAVAILABLE");
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const response = await this.fetchImpl(new URL(path, this.origin), { method, redirect: "error", signal,
        headers: { Authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const result: unknown = JSON.parse(await readBoundedStream(response.body, MAX_RESPONSE_BYTES, signal));
      if (!response.ok) {
        const status = PUBLIC_STATUSES.has(response.status) ? response.status : 503;
        const record = result && typeof result === "object" ? result as Record<string, unknown> : {};
        const messages: Record<number, string> = {400:"设置内容无效",403:"该设置不允许修改",404:"设置资源不存在",409:"内容已变化，请重新读取后保存",503:"微信助手设置服务暂不可用"};
        throw new SettingsHttpError(status, messages[status]!,
          typeof record.code === "string" && /^[A-Za-z_\d-]{1,64}$/.test(record.code) ? record.code : "GATEWAY_SETTINGS_ERROR");
      }
      if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid settings response");
      return result as Record<string, unknown>;
    } catch (error) {
      if (error instanceof SettingsHttpError) throw error;
      throw new SettingsHttpError(503, "微信助手设置服务暂不可用，请稍后重试", "GATEWAY_SETTINGS_UNAVAILABLE");
    }
  }
}
