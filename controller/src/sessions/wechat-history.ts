import { createHash } from "node:crypto";
import { SessionSchema, type Session } from "../types.js";

export const WECHAT_NODE_ID = "wechat";

export interface GatewayWechatChat {
  chatId: string;
  label?: string;
  threadId?: string;
}

export function wechatSessionId(chatId: string): string {
  return `wechat_${createHash("sha256").update(chatId).digest("hex").slice(0, 32)}`;
}

export function wechatHistoryContext(threadId: string): string {
  const digest = createHash("sha256").update(`wechat-history:${threadId}`).digest();
  // RFC 4122 version 4/variant bits keep the opaque context valid for the API schema.
  digest[6] = (digest[6] & 0x0f) | 0x40;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function makeWechatSession(chat: GatewayWechatChat, now = new Date()): Session {
  return SessionSchema.parse({
    id: wechatSessionId(chat.chatId),
    provider: "wechat-codex",
    title: chat.label?.trim() || "主微信对话",
    cwd: "微信主会话",
    status: "idle",
    capabilities: ["read"],
    observedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    loaded: true,
    historySource: "wechat-codex",
  });
}

export function normalizeHistoryContext(value: unknown, threadId: string): string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value : wechatHistoryContext(threadId);
}
