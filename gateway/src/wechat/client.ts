import * as crypto from "node:crypto";
import { InboundWeChatMessage } from "../types.js";
import { StateManager } from "../runtime/state.js";
import { markdownToWeChat, DEFAULT_MESSAGE_MAX_CHARS, unicodeSafeBoundary } from "./markdown.js";
import { DEFAULT_POLL_TIMEOUT_MS, MAX_POLL_TIMEOUT_MS, MAX_POLL_ATTEMPTS, SEND_REQUEST_TIMEOUT_MS, REPLY_TIMEOUT_MS } from "../runtime/budgets.js";
import { validateSendReceipt } from "./send-receipt.js";

export const DEFAULT_ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";
export const CHANNEL_VERSION = "0.3.0";
export const MESSAGE_TYPE_INBOUND_TEXT = 1;
export const MESSAGE_TYPE_OUTBOUND_TEXT = 2;
export const MESSAGE_STATE_OUTBOUND = 2;
export const ITEM_TYPE_TEXT = 1;
export const ERRCODE_CURSOR_TIMEOUT = -14;

export interface ILinkPollBatch {
  nextSyncBuf: string;
  messages: InboundWeChatMessage[];
  rawMessageCount: number;
}

export type FetchLike = typeof globalThis.fetch;

function validateILinkBaseUrl(value: string): string {
  // Do not echo input or URL parser errors: the value can contain credentials.
  const invalid = () => new Error("iLink base URL must use HTTPS without userinfo, query, fragment or control characters");
  if (/[\u0000-\u0020\u007f\\]/u.test(value)) throw invalid();
  let url: URL;
  try { url = new URL(value); }
  catch { throw invalid(); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password ||
      value.includes("?") || value.includes("#")) throw invalid();
  return url.toString().replace(/\/+$/, "");
}

export function splitWeChatReply(renderedText: string, maxChars: number = DEFAULT_MESSAGE_MAX_CHARS): string[] {
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0) {
    throw new RangeError("maxChars must be a positive safe integer");
  }
  if (!renderedText.trim()) {
    return [];
  }
  if (renderedText.length <= maxChars) {
    return [renderedText];
  }
  const chunks: string[] = [];
  let remaining = renderedText;
  while (remaining.length > maxChars) {
    // Keep separators and indentation: splitting must not change code semantics.
    let splitAt = remaining.lastIndexOf("\n", maxChars - 1) + 1;
    if (splitAt <= 0) {
      splitAt = unicodeSafeBoundary(remaining, maxChars);
      if (splitAt === 0) throw new RangeError("maxChars cannot fit the next Unicode character");
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}

export class ILinkClient {
  public readonly baseUrl: string;
  private readonly stateManager: StateManager;
  private readonly fetchImpl: FetchLike;
  private readonly pollTimeoutMs: number;

  constructor(options: {
    stateManager: StateManager;
    configuredBaseUrl?: string;
    pollTimeoutMs?: number;
    fetchImpl?: FetchLike;
  }) {
    this.stateManager = options.stateManager;
    this.pollTimeoutMs = options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.pollTimeoutMs) || this.pollTimeoutMs <= 0 || this.pollTimeoutMs > MAX_POLL_TIMEOUT_MS) {
      throw new Error("Invalid iLink poll timeout budget");
    }
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;

    const selected = options.configuredBaseUrl || this.stateManager.account?.baseUrl || DEFAULT_ILINK_BASE_URL;
    this.baseUrl = validateILinkBaseUrl(selected);
  }

  public get pollBudgetMs(): number { return this.pollTimeoutMs * MAX_POLL_ATTEMPTS; }

  private async request(
    endpoint: string,
    payload: Record<string, unknown>,
    token: string,
    timeoutMs: number,
    parentSignal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    const uinRandom = crypto.randomBytes(4).readUInt32BE(0).toString(10);
    const uinHeader = Buffer.from(uinRandom, "utf8").toString("base64");
    const url = `${this.baseUrl}/${endpoint.replace(/^\/+/, "")}`;

    const controller = new AbortController();
    const signal = parentSignal ? AbortSignal.any([controller.signal, parentSignal]) : controller.signal;
    signal.throwIfAborted();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "AuthorizationType": "ilink_bot_token",
          "X-WECHAT-UIN": uinHeader,
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
        redirect: "error",
        signal,
      });
      if (!response.ok) {
        throw new Error(`WeChat iLink HTTP ${response.status} on ${endpoint}`);
      }
      const parsed: unknown = await response.json();
      signal.throwIfAborted();
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("WeChat iLink returned a non-object JSON response");
      }
      return parsed as Record<string, unknown>;
    } finally {
      clearTimeout(timer);
    }
  }

  public async pollBatch(): Promise<ILinkPollBatch> {
    const account = this.stateManager.account;
    if (!account || !account.token) {
      throw new Error("WeChat is not logged in; missing valid credentials token");
    }

    const currentSyncBuf = this.stateManager.syncBuf;
    let response = await this.request(
      "ilink/bot/getupdates",
      {
        get_updates_buf: currentSyncBuf,
        base_info: { channel_version: CHANNEL_VERSION },
      },
      account.token,
      this.pollTimeoutMs
    );

    const errcode = response.errcode;
    const errmsg = String(response.errmsg ?? "");
    if (errcode === ERRCODE_CURSOR_TIMEOUT && errmsg.toLowerCase().includes("timeout") && currentSyncBuf) {
      this.stateManager.commitCursor("");
      response = await this.request(
        "ilink/bot/getupdates",
        {
          get_updates_buf: "",
          base_info: { channel_version: CHANNEL_VERSION },
        },
        account.token,
        this.pollTimeoutMs
      );
    }

    const ret = response.ret;
    const finalErrcode = response.errcode;
    if ((ret !== undefined && ret !== null && ret !== 0) || (finalErrcode !== undefined && finalErrcode !== null && finalErrcode !== 0)) {
      throw new Error(
        `WeChat getupdates failed: ret=${String(ret)} errcode=${String(finalErrcode)}`
      );
    }

    const nextSyncBuf = typeof response.get_updates_buf === "string" && response.get_updates_buf
      ? response.get_updates_buf
      : this.stateManager.syncBuf;

    const rawMsgs = Array.isArray(response.msgs) ? response.msgs : [];
    const messages: InboundWeChatMessage[] = [];

    for (let msgIdx = 0; msgIdx < rawMsgs.length; msgIdx++) {
      const rawMsg = rawMsgs[msgIdx];
      if (typeof rawMsg !== "object" || rawMsg === null) continue;
      const msg = rawMsg as Record<string, unknown>;
      if (msg.message_type !== MESSAGE_TYPE_INBOUND_TEXT) continue;

      const sender = String(msg.from_user_id || "unknown");
      const itemList = Array.isArray(msg.item_list) ? msg.item_list : [];
      let textContent = "";
      for (const rawItem of itemList) {
        if (typeof rawItem === "object" && rawItem !== null) {
          const item = rawItem as Record<string, unknown>;
          if (item.type === ITEM_TYPE_TEXT && typeof item.text_item === "object" && item.text_item !== null) {
            const textItem = item.text_item as Record<string, unknown>;
            if (typeof textItem.text === "string") {
              textContent += textItem.text;
            }
          }
        }
      }
      if (!textContent) continue;

      const contextToken = typeof msg.context_token === "string" && msg.context_token ? msg.context_token : undefined;
      if (contextToken) {
        this.stateManager.setContextToken(sender, contextToken);
      }

      const clientId = typeof msg.client_id === "string" || typeof msg.client_id === "number"
        ? String(msg.client_id)
        : "";
      const createTimeMs = typeof msg.create_time_ms === "string" || typeof msg.create_time_ms === "number"
        ? String(msg.create_time_ms)
        : "";

      // Deterministic messageId and deliveryKey across poll retries
      let messageId: string;
      let deliveryKey: string;
      if (clientId) {
        messageId = clientId;
        deliveryKey = this.stateManager.computeDeliveryKey(sender, clientId);
      } else {
        // Compute deterministic hash without randomUUID so retry has stable messageId & deliveryKey
        const rawDigest = crypto.createHash("sha256")
          .update(`${account.accountId}:${sender}:${createTimeMs}:${currentSyncBuf}:${msgIdx}:${textContent}`, "utf8")
          .digest("hex").slice(0, 24);
        messageId = `det:${rawDigest}`;
        deliveryKey = this.stateManager.computeDeliveryKey(sender, messageId);
      }

      if (deliveryKey && this.stateManager.isMessageProcessed(deliveryKey)) {
        continue;
      }

      messages.push({
        chatId: sender,
        text: textContent,
        messageId,
        deliveryKey,
        contextToken,
      });
    }

    return { nextSyncBuf, messages, rawMessageCount: rawMsgs.length };
  }

  public async sendSingleText(chatId: string, formattedText: string, clientIdOverride?: string, signal?: AbortSignal): Promise<void> {
    const account = this.stateManager.account;
    if (!account || !account.token) {
      throw new Error("WeChat is not logged in");
    }
    const contextToken = this.stateManager.contextTokens[chatId];
    if (!contextToken) {
      throw new Error(`No context token for chat ${chatId}; poll a new inbound message first`);
    }
    const clientId = clientIdOverride || `super-leader:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const response = await this.request(
      "ilink/bot/sendmessage",
      {
        msg: {
          from_user_id: "",
          to_user_id: chatId,
          client_id: clientId,
          message_type: MESSAGE_TYPE_OUTBOUND_TEXT,
          message_state: MESSAGE_STATE_OUTBOUND,
          item_list: [{ type: ITEM_TYPE_TEXT, text_item: { text: formattedText } }],
          context_token: contextToken,
        },
        base_info: { channel_version: CHANNEL_VERSION },
      },
      account.token,
      SEND_REQUEST_TIMEOUT_MS,
      signal
    );

    validateSendReceipt(response);
  }

  public async sendMarkdownReply(
    chatId: string,
    rawMarkdown: string,
    options?: { deliveryKey?: string; maxCharsPerChunk?: number; splitMultiPart?: boolean }
  ): Promise<number> {
    const maxChars = options?.maxCharsPerChunk ?? DEFAULT_MESSAGE_MAX_CHARS;
    const splitMultiPart = options?.splitMultiPart ?? true;
    const deliveryKey = options?.deliveryKey || "";
    const replyController = new AbortController();
    const replyTimer = setTimeout(() => replyController.abort(new Error("WeChat reply timed out")), REPLY_TIMEOUT_MS);
    try {
      if (!splitMultiPart) {
        const single = markdownToWeChat(rawMarkdown, maxChars);
        if (!single) return 0;
        const deterministicClientId = deliveryKey
          ? `super-leader:${crypto.createHash("sha256").update(`${deliveryKey}:chunk:0`).digest("hex").slice(0, 24)}`
          : undefined;
        await this.sendSingleText(chatId, single, deterministicClientId, replyController.signal);
        return 1;
      }

      const renderedFull = markdownToWeChat(rawMarkdown, Number.MAX_SAFE_INTEGER);
      const chunks = splitWeChatReply(renderedFull, maxChars);
      if (chunks.length === 0) return 0;

      const alreadySent = deliveryKey ? this.stateManager.getReplySentChunks(deliveryKey) : 0;
      for (let idx = alreadySent; idx < chunks.length; idx++) {
        const deterministicClientId = deliveryKey
          ? `super-leader:${crypto.createHash("sha256").update(`${deliveryKey}:chunk:${idx}`).digest("hex").slice(0, 24)}`
          : undefined;
        replyController.signal.throwIfAborted();
        await this.sendSingleText(chatId, chunks[idx], deterministicClientId, replyController.signal);
        if (deliveryKey && (chunks.length > 1 || idx + 1 < chunks.length)) {
          this.stateManager.recordReplyChunkProgress(deliveryKey, idx + 1);
        }
      }
      return chunks.length;
    } finally {
      clearTimeout(replyTimer);
    }
  }
}
