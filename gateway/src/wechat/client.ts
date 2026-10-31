import { performance } from "node:perf_hooks";
import { traceEvent, traceSpan } from "../runtime/telemetry.js";
import * as crypto from "node:crypto";
import { InboundWeChatMessage } from "../types.js";
import { StateManager } from "../runtime/state.js";
import { DEFAULT_MESSAGE_MAX_CHARS, legacyWeChatCitationBody, markdownToWeChat, unicodeSafeBoundary } from "./markdown.js";
import { DEFAULT_POLL_TIMEOUT_MS, MAX_POLL_TIMEOUT_MS, POLL_NETWORK_MARGIN_MS, MAX_POLL_ATTEMPTS, SEND_REQUEST_TIMEOUT_MS, REPLY_TIMEOUT_MS, NOTIFICATION_REPLY_TIMEOUT_MS } from "../runtime/budgets.js";
import { ILinkSendReceiptError, parseILinkJson, validateSendReceipt } from "./send-receipt.js";
import { TypingIndicator } from "./typing.js";
import { ImageUploader, type UploadedImageItem, type UploadRequest } from "./media-upload.js";
import { sendImageReply as deliverImages, validateImageAttachments, type ImageAttachment } from "./media-delivery.js";
import { FileUploader, type FileUploadMetadata, type UploadedFileItem } from "./file-upload.js";
import { deliverFileReply, type FileReplyOptions } from "./file-delivery.js";
import { beforeAbort } from "../runtime/abort.js";
import { CHANNEL_VERSION } from "./protocol.js";
export { CHANNEL_VERSION } from "./protocol.js";

// Only used to reconstruct deliveries written by the short-lived citation-sanitizing
// release. New deliveries always use the caller's original text.
export const DEFAULT_ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";
export const MESSAGE_TYPE_INBOUND_TEXT = 1;
export const MESSAGE_TYPE_OUTBOUND_TEXT = 2;
export const MESSAGE_STATE_OUTBOUND = 2;
export const ITEM_TYPE_TEXT = 1;

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
  if (renderedText.length === 0) {
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
  private pollTimeoutMs: number;
  private readonly typing: TypingIndicator;
  private readonly chatSends = new Map<string, Promise<void>>();
  private readonly imageUploader: ImageUploader;
  private readonly fileUploader: FileUploader;
  private beforeSendCheck?: (chatId: string, deliveryKey?: string) => void;

  /** Called synchronously under the chat send lock, before spending quota or persisting send intent. */
  public setBeforeSendCheck(check: (chatId: string, deliveryKey?: string) => void): void {
    this.beforeSendCheck = check;
  }

  private consumeSendBudget(chatId: string, deliveryKey?: string, kind: "final" | "progress" = "final"): void {
    this.beforeSendCheck?.(chatId, deliveryKey);
    this.stateManager.consumeSendBudget(chatId, kind);
  }

  constructor(options: {
    stateManager: StateManager;
    configuredBaseUrl?: string;
    pollTimeoutMs?: number;
    fetchImpl?: FetchLike;
    maxFileBytes?: number;
  }) {
    this.stateManager = options.stateManager;
    this.pollTimeoutMs = options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.pollTimeoutMs) || this.pollTimeoutMs <= 0 || this.pollTimeoutMs > MAX_POLL_TIMEOUT_MS) {
      throw new Error("Invalid iLink poll timeout budget");
    }
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;

    const selected = options.configuredBaseUrl || this.stateManager.account?.baseUrl || DEFAULT_ILINK_BASE_URL;
    this.baseUrl = validateILinkBaseUrl(selected);
    this.typing = new TypingIndicator({
      request: (endpoint, payload, token, timeoutMs, signal) => this.request(endpoint, payload, token, timeoutMs, signal),
      getAccount: () => this.stateManager.account ? {
        token: this.stateManager.account.token, fingerprint: this.stateManager.getLoginFingerprint(),
      } : null,
      getContextToken: chatId => this.stateManager.contextTokens[chatId],
    });
    const uploadRequest: UploadRequest = (endpoint, payload, timeoutMs, signal) => {
      const token = this.stateManager.account?.token;
      if (!token) throw new Error("WeChat is not logged in");
      return this.request(endpoint, { ...payload, base_info: { channel_version: CHANNEL_VERSION } }, token, timeoutMs, signal);
    };
    this.imageUploader = new ImageUploader({ fetchImpl: this.fetchImpl, request: uploadRequest });
    this.fileUploader = new FileUploader({
      fetchImpl: this.fetchImpl, request: uploadRequest, maxFileBytes: options.maxFileBytes,
    });
  }

  public get pollBudgetMs(): number { return (this.pollTimeoutMs + POLL_NETWORK_MARGIN_MS) * MAX_POLL_ATTEMPTS; }

  public sendTyping(chatId: string, status: 1 | 2 = 1): void {
    // send() owns its timeout and error handling; indicators never gate real work.
    void this.typing.send(chatId, status);
  }

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
    const started = performance.now();
    const purpose = endpoint === "ilink/bot/sendmessage" ? "sendmessage"
      : endpoint === "ilink/bot/getupdates" ? "getupdates"
      : endpoint === "ilink/bot/getconfig" ? "getconfig" : endpoint === "ilink/bot/sendtyping" ? "sendtyping" : "media";
    let outcome = "error";
    traceEvent("wechat.http.start", { purpose });
    try {
      const response = await beforeAbort(this.fetchImpl(url, {
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
      }), signal);
      traceEvent("wechat.http.headers", { purpose, httpStatus: response.status, durationMs: performance.now() - started });
      if (!response.ok) {
        throw new Error(`WeChat iLink HTTP ${response.status} on ${endpoint}`);
      }
      const raw = await beforeAbort(response.text(), signal);
      if (!raw.trim() && endpoint === "ilink/bot/sendmessage") throw new ILinkSendReceiptError("EmptyResponse");
      const parsed = parseILinkJson(raw);
      signal.throwIfAborted();
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("WeChat iLink returned a non-object JSON response");
      }
      outcome = "ok";
      return parsed as Record<string, unknown>;
    } finally {
      traceEvent("wechat.http.end", { purpose, outcome, durationMs: performance.now() - started });
      clearTimeout(timer);
      controller.abort();
    }
  }

  public async pollBatch(): Promise<ILinkPollBatch> {
    const account = this.stateManager.account;
    if (!account || !account.token) {
      throw new Error("WeChat is not logged in; missing valid credentials token");
    }

    const currentSyncBuf = this.stateManager.syncBuf;
    const response = await this.request(
      "ilink/bot/getupdates",
      {
        get_updates_buf: currentSyncBuf,
        base_info: { channel_version: CHANNEL_VERSION },
      },
      account.token,
      this.pollBudgetMs
    );

    const ret = response.ret;
    const finalErrcode = response.errcode;
    if ((ret !== undefined && ret !== null && ret !== 0) || (finalErrcode !== undefined && finalErrcode !== null && finalErrcode !== 0)) {
      throw new Error(
        `WeChat getupdates failed: ret=${String(ret)} errcode=${String(finalErrcode)}`
      );
    }

    const suggestedTimeout = response.longpolling_timeout_ms;
    // Invalid or unbounded hints never change the last usable local budget.
    if (typeof suggestedTimeout === "number" && Number.isSafeInteger(suggestedTimeout) &&
        suggestedTimeout > 0 && suggestedTimeout <= MAX_POLL_TIMEOUT_MS) {
      this.pollTimeoutMs = suggestedTimeout;
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
        deliveryKey = this.stateManager.computeDeliveryKey(sender, stableId);
      } else {
        // Without a stable ID, only retries of the same page position are identifiable.
        // Keep positions distinct so identical commands are not silently merged across pages.
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
        createdAtMs,
      });
    }

    return { nextSyncBuf, messages, rawMessageCount: rawMsgs.length };
  }

  public async sendSingleText(chatId: string, formattedText: string, clientIdOverride?: string, signal?: AbortSignal): Promise<void> {
    await this.withChatSend(chatId, () => {
      this.consumeSendBudget(chatId);
      return this.sendSingleTextNow(chatId, formattedText, clientIdOverride, signal);
    }, signal);
  }

  private async withChatSend<T>(chatId: string, send: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = this.chatSends.get(chatId) ?? Promise.resolve();
    let release!: () => void;
    const slot = new Promise<void>(resolve => { release = resolve; });
    const current = previous.then(() => slot);
    this.chatSends.set(chatId, current);
    void current.then(() => {
      if (this.chatSends.get(chatId) === current) this.chatSends.delete(chatId);
    });
    const queueStarted = performance.now();
    try {
      if (signal) await beforeAbort(previous, signal);
      else await previous;
      signal?.throwIfAborted();
      traceEvent("wechat.send.lock.acquired", { durationMs: performance.now() - queueStarted });
      return await send();
    } finally {
      release();
    }
  }

  private async sendSingleTextNow(chatId: string, formattedText: string, clientIdOverride?: string, signal?: AbortSignal): Promise<void> {
    await this.sendMessageItem(chatId, { type: ITEM_TYPE_TEXT, text_item: { text: formattedText } }, clientIdOverride, signal);
  }

  private async sendMessageItem(chatId: string, item: Record<string, unknown> | UploadedImageItem | UploadedFileItem,
    clientIdOverride?: string, signal?: AbortSignal): Promise<void> {
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
          item_list: [item],
          context_token: contextToken,
        },
        base_info: { channel_version: CHANNEL_VERSION },
      },
      account.token,
      SEND_REQUEST_TIMEOUT_MS,
      signal
    );

    await traceSpan("wechat.send.receipt.validate", async () => validateSendReceipt(response));
    traceEvent("wechat.send.accepted");
  }

  public async sendImageReply(chatId: string, images: ImageAttachment[], options: {
    deliveryKey: string;
    getImageBytes: (image: ImageAttachment, signal?: AbortSignal) => Promise<Buffer>;
    timeoutMs?: number;
    signal?: AbortSignal;
    shouldContinue?: () => boolean;
  }): Promise<number> {
    const attachments = validateImageAttachments(images);
    if (attachments.length === 0) return 0;
    const fingerprint = this.stateManager.getLoginFingerprint();
    const contextToken = this.stateManager.contextTokens[chatId];
    const budgetEpoch = this.stateManager.accountSendBudget?.lastInboundKey;
    const windowKey = this.stateManager.contextWindows[chatId]?.lastInboundKey;
    if (!fingerprint || !contextToken) throw new Error("WeChat image delivery requires an active account and chat context");
    const shouldContinue = () => fingerprint === this.stateManager.getLoginFingerprint() &&
      contextToken === this.stateManager.contextTokens[chatId] &&
      budgetEpoch === this.stateManager.accountSendBudget?.lastInboundKey &&
      windowKey === this.stateManager.contextWindows[chatId]?.lastInboundKey && (!options.shouldContinue || options.shouldContinue());
    const timeoutMs = options.timeoutMs ?? REPLY_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > NOTIFICATION_REPLY_TIMEOUT_MS) {
      throw new Error("Invalid WeChat image reply timeout budget");
    }
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(new Error("WeChat image reply timed out")), timeoutMs);
    try {
      return await this.withChatSend(chatId, async () => {
        if (!shouldContinue()) throw new Error("WeChat image reply interrupted before completion");
        this.sendTyping(chatId);
        return deliverImages({ stateManager: this.stateManager, chatId, deliveryKey: options.deliveryKey,
          images: attachments, getImageBytes: options.getImageBytes,
          uploadImage: bytes => {
            if (!shouldContinue()) throw new Error("WeChat image reply interrupted before completion");
            return this.imageUploader.upload(chatId, bytes, signal);
          },
          sendImage: (item, clientId) => this.sendMessageItem(chatId, item, clientId, signal),
          beforeBeginChunk: () => this.consumeSendBudget(chatId, options.deliveryKey),
          signal, shouldContinue,
        });
      }, signal);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  public async sendFileReply(chatId: string, bytes: Buffer, metadata: FileUploadMetadata,
    options: FileReplyOptions): Promise<number> {
    return deliverFileReply({
      ...options, chatId, bytes, metadata, state: this.stateManager,
      upload: (input, attachment, signal) => this.fileUploader.upload(chatId, input, attachment, signal),
      withChatSend: (send, signal) => this.withChatSend(chatId, send, signal),
      consumeBudget: () => this.consumeSendBudget(chatId, options.deliveryKey, options.kind),
      send: (item, clientId, signal) => this.sendMessageItem(chatId, item, clientId, signal),
    });
  }

  public async sendMarkdownReply(
    chatId: string,
    rawMarkdown: string,
    options?: { deliveryKey?: string; maxCharsPerChunk?: number;
      timeoutMs?: number; signal?: AbortSignal; shouldContinue?: () => boolean; kind?: "final" | "progress";
      /** Renewal reminders may replace only an unsent legacy reminder checkpoint. */
      renewalReminder?: boolean;
      /** Controller result messages are already split and must keep their frozen boundaries. */
      verbatim?: boolean }
  ): Promise<number> {
    const renderStarted = performance.now();
    const maxChars = options?.maxCharsPerChunk ?? DEFAULT_MESSAGE_MAX_CHARS;
    const deliveryKey = options?.deliveryKey || `reply:${crypto.randomUUID()}`;
    const hash = (value: unknown) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const identity = [this.stateManager.getLoginFingerprint(), chatId, maxChars, rawMarkdown];
    const legacyDigest = hash(identity);
    // Existing raw or formatted plans must finish with exactly their original chunks, even after an upgrade.
    const existing = this.stateManager.replyDeliveries[deliveryKey];
    const requestedVerbatim = options?.verbatim === true;
    const existingDigest = existing?.digest;
    let rendered: string;
    let digest: string;
    if (existingDigest === legacyDigest) {
      rendered = rawMarkdown;
      digest = existingDigest;
    } else if (existingDigest !== undefined && existingDigest === hash([...identity, "wechat-verbatim-v2", rawMarkdown])) {
      rendered = rawMarkdown;
      digest = existingDigest;
    } else if (existingDigest !== undefined) {
      const legacyUnsanitizedRendered = markdownToWeChat(rawMarkdown, Number.MAX_SAFE_INTEGER);
      if (existingDigest === hash([...identity, "wechat-plain-v1", legacyUnsanitizedRendered])) {
        rendered = legacyUnsanitizedRendered;
        digest = existingDigest;
      } else {
        const legacyBody = legacyWeChatCitationBody(rawMarkdown);
        const legacySanitizedRendered = markdownToWeChat(legacyBody, Number.MAX_SAFE_INTEGER);
        if (existingDigest === hash([...identity, "wechat-plain-v1", legacySanitizedRendered])) {
          rendered = legacySanitizedRendered;
          digest = existingDigest;
        } else if (existingDigest === hash([...identity, "wechat-verbatim-v2", legacyBody])) {
          rendered = legacyBody;
          digest = existingDigest;
        } else {
          rendered = requestedVerbatim ? rawMarkdown : legacyUnsanitizedRendered;
          digest = hash([...identity, requestedVerbatim ? "wechat-verbatim-v2" : "wechat-plain-v1", rendered]);
        }
      }
    } else {
      rendered = requestedVerbatim ? rawMarkdown : markdownToWeChat(rawMarkdown, Number.MAX_SAFE_INTEGER);
      digest = hash([...identity, requestedVerbatim ? "wechat-verbatim-v2" : "wechat-plain-v1", rendered]);
    }
    // Render the complete body before splitting so delimiters cannot straddle new chunks.
    const chunks = splitWeChatReply(rendered, maxChars);
    if (chunks.length === 0) return 0;
    const timeoutMs = options?.timeoutMs ?? REPLY_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > NOTIFICATION_REPLY_TIMEOUT_MS) {
      throw new Error("Invalid WeChat reply timeout budget");
    }
    options?.signal?.throwIfAborted();
    traceEvent("wechat.reply.rendered", { chars: rendered.length, chunkCount: chunks.length,
      durationMs: performance.now() - renderStarted });
    const delivery = await traceSpan("wechat.reply.plan.persist", async () =>
      options?.renewalReminder
        ? this.stateManager.prepareRenewalReplyDelivery(deliveryKey, digest, chunks.length)
        : this.stateManager.prepareReplyDelivery(deliveryKey, digest, chunks.length));
    traceEvent("wechat.reply.plan", { chunkCount: chunks.length, acknowledgedChunks: delivery.acknowledgedChunks });
    if (delivery.acknowledgedChunks === chunks.length) {
      traceEvent("wechat.reply.reused", { outcome: "replayed" });
      return chunks.length;
    }
    const replyController = new AbortController();
    const replySignal = options?.signal ? AbortSignal.any([replyController.signal, options.signal]) : replyController.signal;
    const replyTimer = setTimeout(() => replyController.abort(new Error("WeChat reply timed out")), timeoutMs);
    try {
      this.sendTyping(chatId);
      for (let idx = delivery.acknowledgedChunks; idx < chunks.length; idx++) {
        const deterministicClientId = `super-leader:${crypto.createHash("sha256")
          .update(JSON.stringify([this.stateManager.getLoginFingerprint(), chatId, deliveryKey, idx])).digest("hex").slice(0, 24)}`;
        replySignal.throwIfAborted();
        if (options?.shouldContinue && !options.shouldContinue()) throw new Error("WeChat reply interrupted before completion");
        await this.withChatSend(chatId, async () => {
          if (options?.shouldContinue && !options.shouldContinue()) throw new Error("WeChat reply interrupted before completion");
          this.consumeSendBudget(chatId, deliveryKey, options?.kind);
          // Persist intent before the network call. A crash or ambiguous response cannot trigger a replay.
          traceEvent("wechat.chunk.start", { chunkIndex: idx, chunkCount: chunks.length });
          // Do not yield between charging the ledger, persisting intent and starting the request.
          this.stateManager.beginReplyChunk(deliveryKey, idx);
          traceEvent("wechat.chunk.intent.persist", { chunkIndex: idx });
          try {
            await traceSpan("wechat.chunk.send", () => this.sendSingleTextNow(chatId, chunks[idx], deterministicClientId, replySignal), { chunkIndex: idx });
          } catch (error) {
            if (error instanceof ILinkSendReceiptError &&
                (error.reason === "RejectedRet" || error.reason === "RejectedErrcode")) {
              this.stateManager.rejectReplyChunk(deliveryKey, idx);
              traceEvent("wechat.chunk.rejected", { chunkIndex: idx });
            }
            traceEvent("wechat.chunk.failed", { chunkIndex: idx,
              receiptStatus: this.stateManager.hasUncertainReply(deliveryKey) ? "uncertain" : "rejected" });
            throw error;
          }
          await traceSpan("wechat.chunk.receipt.persist", async () => this.stateManager.confirmReplyChunk(deliveryKey, idx), { chunkIndex: idx });
          traceEvent("wechat.chunk.accepted", { chunkIndex: idx, chunkCount: chunks.length });
        }, replySignal);
      }
      return chunks.length;
    } finally {
      clearTimeout(replyTimer);
    }
  }
}
