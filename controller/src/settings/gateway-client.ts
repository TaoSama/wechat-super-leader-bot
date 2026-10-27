import { readBoundedStream } from "../leader/model/transport.js";
import { z } from "zod";
import { HISTORY_MAX_CURSOR_LENGTH, HISTORY_MAX_LIMIT, HISTORY_MAX_TEXT_LENGTH, HistoryItemSchema, type HistoryItem } from "../types.js";
import type { GatewayWechatChat } from "../sessions/wechat-history.js";

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

  async listWechatChats(timeoutMs = REQUEST_TIMEOUT_MS): Promise<GatewayWechatChat[]> {
    const result = await this.request("/settings", "GET", undefined, timeoutMs);
    const parsed = z.object({ chats: z.array(z.object({
      chatId: z.string().min(1).max(64),
      label: z.string().max(256).optional(),
      threadId: z.string().min(1).max(256).optional(),
    }).passthrough()).max(64) }).passthrough().safeParse(result);
    if (!parsed.success) throw new SettingsHttpError(503, "微信助手会话目录无效", "GATEWAY_SETTINGS_INVALID");
    return parsed.data.chats;
  }

  async readWechatHistory(chatId: string, options: { cursor?: string; limit?: number; historyContext?: string }, timeoutMs = REQUEST_TIMEOUT_MS): Promise<{
    threadId: string;
    historyContext?: string;
    items: HistoryItem[];
    nextCursor: string | null;
    fetchedAt: string;
    truncated: boolean;
    turnStatuses?: Record<string, "inProgress" | "completed" | "failed" | "interrupted">;
  }> {
    const limit = options.limit ?? 30;
    if (!Number.isInteger(limit) || limit < 1 || limit > HISTORY_MAX_LIMIT ||
        (options.cursor !== undefined && (options.cursor.length < 1 || options.cursor.length > HISTORY_MAX_CURSOR_LENGTH)) ||
        (options.cursor !== undefined && !options.historyContext)) {
      throw new SettingsHttpError(400, "历史查询参数无效", "history_invalid_request");
    }
    const search = new URLSearchParams({ chatId, limit: String(limit) });
    if (options.cursor) search.set("cursor", options.cursor);
    if (options.historyContext) search.set("historyContext", options.historyContext);
    const result = await this.request(`/settings/leader-history?${search.toString()}`, "GET", undefined, timeoutMs);
    const parsed = z.object({
      // An authorized chat may not have started its first Codex turn yet.
      // Gateway represents that state with an empty thread ID and an empty page.
      threadId: z.string().max(256),
      historyContext: z.string().uuid().optional(),
      items: z.array(HistoryItemSchema).max(HISTORY_MAX_LIMIT),
      nextCursor: z.string().min(1).max(HISTORY_MAX_CURSOR_LENGTH).nullable(),
      fetchedAt: z.string().datetime({ offset: true }),
      truncated: z.boolean(),
      turnStatuses: z.record(z.string(), z.enum(["inProgress", "completed", "failed", "interrupted"])).optional(),
    }).strict().safeParse(result);
    if (!parsed.success) throw new SettingsHttpError(503, "微信助手历史响应无效", "history_invalid_response");
    if (parsed.data.items.some(item => item.text.length > HISTORY_MAX_TEXT_LENGTH ||
        Buffer.byteLength(item.id, "utf8") > 256 || Buffer.byteLength(item.turnId, "utf8") > 128)) {
      throw new SettingsHttpError(503, "微信助手历史响应过大", "history_too_large");
    }
    return parsed.data;
  }
}
