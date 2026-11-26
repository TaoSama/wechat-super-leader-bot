import * as crypto from "node:crypto";
import type { InboundWeChatMessage } from "../types.js";
import type { StateManager } from "../runtime/state.js";
import { traceEvent } from "../runtime/telemetry.js";
import { parseInboundContent } from "./inbound-content.js";

export const MESSAGE_TYPE_INBOUND_TEXT = 1;
export interface ILinkPollBatch {
  nextSyncBuf: string;
  messages: InboundWeChatMessage[];
  rawMessageCount: number;
}

export function validatePollResponse(response: Record<string, unknown>): void {
  const { ret, errcode } = response;
  if ((ret !== undefined && ret !== null && ret !== 0) ||
      (errcode !== undefined && errcode !== null && errcode !== 0)) {
    // Response strings and objects can carry credentials or message contents.
    const code = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) ? value : null;
    traceEvent("wechat.poll.rejected", { ret: code(ret), errcode: code(errcode) });
    throw new Error("WeChat getupdates failed");
  }
}

export function parsePollBatch(response: Record<string, unknown>, stateManager: StateManager,
  accountId: string, currentSyncBuf: string): ILinkPollBatch {
  const nextSyncBuf = typeof response.get_updates_buf === "string" && response.get_updates_buf
    ? response.get_updates_buf
    : stateManager.syncBuf;

  const rawMsgs = Array.isArray(response.msgs) ? response.msgs : [];
  const messages: InboundWeChatMessage[] = [];

  for (let msgIdx = 0; msgIdx < rawMsgs.length; msgIdx++) {
    const rawMsg = rawMsgs[msgIdx];
    if (typeof rawMsg !== "object" || rawMsg === null) continue;
    const msg = rawMsg as Record<string, unknown>;
    if (msg.message_type !== MESSAGE_TYPE_INBOUND_TEXT) continue;

    const sender = String(msg.from_user_id || "unknown");
    const itemList = Array.isArray(msg.item_list) ? msg.item_list : [];
    const content = parseInboundContent(itemList);
    if (!content) continue;
    // Legacy deterministic IDs hashed only the sender's text; unsupported content hashes its kinds.
    // Media-only messages hash their CDN references so distinct pictures stay distinct.
    const identityText = content.unsupportedKinds ? `unsupported:${content.unsupportedKinds.join(",")}`
      : content.ownText || `media:${crypto.createHash("sha256").update(JSON.stringify(content.media ?? [])).digest("hex")}`;

    const contextToken = typeof msg.context_token === "string" && msg.context_token ? msg.context_token : undefined;

    const clientId = typeof msg.client_id === "string" && msg.client_id.trim() ||
      typeof msg.client_id === "number" && Number.isSafeInteger(msg.client_id) && msg.client_id >= 0
      ? String(msg.client_id) : "";
    const serverMessageId = typeof msg.message_id === "string" && /^\d+$/.test(msg.message_id)
      ? `server:${msg.message_id}` : "";
    const stableId = clientId || serverMessageId;
    const createTimeMs = typeof msg.create_time_ms === "string" || typeof msg.create_time_ms === "number"
      ? String(msg.create_time_ms)
      : "";
    const parsedCreateTime = /^\d+$/.test(createTimeMs) ? Number(createTimeMs) : Number.NaN;
    // Invalid platform timestamps are absent from the message contract. NaN would
    // leak an invalid number through pollBatch even though all consumers reject it.
    const createdAtMs = Number.isSafeInteger(parsedCreateTime) && parsedCreateTime >= 0
      ? parsedCreateTime : undefined;

    // Preserve client identities already stored in checkpoints before using server IDs.
    let messageId: string;
    let deliveryKey: string;
    if (stableId) {
      messageId = stableId;
      deliveryKey = stateManager.computeDeliveryKey(sender, stableId);
    } else {
      // Without a stable ID, only retries of the same page position are identifiable.
      // Keep positions distinct so identical commands are not silently merged across pages.
      const rawDigest = crypto.createHash("sha256")
        .update(`${accountId}:${sender}:${createTimeMs}:${currentSyncBuf}:${msgIdx}:${identityText}`, "utf8")
        .digest("hex").slice(0, 24);
      messageId = `det:${rawDigest}`;
      deliveryKey = stateManager.computeDeliveryKey(sender, messageId);
    }

    if (deliveryKey && stateManager.isMessageProcessed(deliveryKey)) {
      continue;
    }

    messages.push({
      chatId: sender,
      text: content.text,
      messageId,
      deliveryKey,
      contextToken,
      createdAtMs,
      ...(content.unsupportedKinds ? { unsupportedKinds: content.unsupportedKinds } : {}),
      ...(content.media ? { media: content.media } : {}),
    });
  }

  return { nextSyncBuf, messages, rawMessageCount: rawMsgs.length };
}
