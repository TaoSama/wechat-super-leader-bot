import { LocalSendDeferredError } from "../runtime/context-policy.js";
import { createHash } from "node:crypto";
import type { StateManager } from "../runtime/state.js";
import { beforeAbort } from "../runtime/abort.js";
import { transferTimeoutMs } from "../runtime/transfer-budget.js";
import { MEDIA_UPLOAD_TIMEOUT_MS } from "./cdn-upload.js";
import { CHECKPOINT_MARGIN_MS, SEND_REQUEST_TIMEOUT_MS, NOTIFICATION_REPLY_TIMEOUT_MS, REPLY_TIMEOUT_MS } from "../runtime/budgets.js";
import type { FileUploadMetadata, UploadedFileItem } from "./file-upload.js";
import { ILinkSendReceiptError } from "./send-receipt.js";

export interface FileReplyOptions {
  deliveryKey: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  shouldContinue?: () => boolean;
  kind?: "final" | "progress";
}
interface FileDeliveryOptions extends FileReplyOptions {
  chatId: string;
  bytes: Buffer;
  metadata: FileUploadMetadata;
  state: Pick<StateManager, "getLoginFingerprint" | "contextTokens" | "prepareReplyDelivery" |
    "beginReplyChunk" | "rejectReplyChunk" | "confirmReplyChunk"> & {
      contextWindows?: Record<string, { refreshedAt: number }>;
      accountSendBudget?: { lastInboundKey: string };
    };
  upload: (bytes: Buffer, metadata: FileUploadMetadata, signal: AbortSignal) => Promise<UploadedFileItem>;
  withChatSend: <T>(send: () => Promise<T>, signal: AbortSignal) => Promise<T>;
  consumeBudget: () => void;
  send: (item: UploadedFileItem, clientId: string, signal: AbortSignal) => Promise<void>;
}

/** CDN work can retry safely; only sendmessage crosses the persisted uncertainty boundary. */
export async function deliverFileReply(options: FileDeliveryOptions): Promise<number> {
  const { state, chatId, deliveryKey } = options;
  if (typeof chatId !== "string" || !chatId.trim() || typeof deliveryKey !== "string" || !deliveryKey.trim()) {
    throw new Error("WeChat file delivery requires stable identity");
  }
  const timeoutMs = options.timeoutMs ?? Math.max(REPLY_TIMEOUT_MS,
    transferTimeoutMs(options.bytes.length, MEDIA_UPLOAD_TIMEOUT_MS) + SEND_REQUEST_TIMEOUT_MS + CHECKPOINT_MARGIN_MS);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > NOTIFICATION_REPLY_TIMEOUT_MS) {
    throw new Error("Invalid WeChat file reply timeout budget");
  }
  options.signal?.throwIfAborted();
  const account = state.getLoginFingerprint(), context = state.contextTokens[chatId];
  const refreshedAt = state.contextWindows?.[chatId]?.refreshedAt, budgetEpoch = state.accountSendBudget?.lastInboundKey;
  if (!account || !context) throw new Error("WeChat file delivery requires an active account and chat context");
  const metadata = { fileName: options.metadata.fileName, byteLength: options.metadata.byteLength,
    sha256: options.metadata.sha256 };
  const digest = createHash("sha256").update(JSON.stringify([
    account, chatId, "file-v1", metadata.fileName, metadata.byteLength, metadata.sha256,
  ])).digest("hex");
  const prepare = () => state.prepareReplyDelivery(deliveryKey, digest, 1);
  if (prepare().acknowledgedChunks === 1) return 1;
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(new Error("WeChat file reply timed out")), timeoutMs);
  const assertCurrent = () => {
    signal.throwIfAborted();
    if (account !== state.getLoginFingerprint() || context !== state.contextTokens[chatId] ||
        refreshedAt !== state.contextWindows?.[chatId]?.refreshedAt || budgetEpoch !== state.accountSendBudget?.lastInboundKey ||
        options.shouldContinue && !options.shouldContinue()) {
      throw new LocalSendDeferredError("context_changed", "WeChat file reply interrupted before completion");
    }
  };
  try {
    assertCurrent();
    const uploaded = await beforeAbort(options.upload(options.bytes, metadata, signal), signal);
    assertCurrent();
    return await options.withChatSend(async () => {
      assertCurrent();
      // Concurrent callers may have completed or become uncertain while this upload was in progress.
      if (prepare().acknowledgedChunks === 1) return 1;
      const clientId = `super-leader:file:${createHash("sha256")
        .update(JSON.stringify([account, chatId, deliveryKey])).digest("hex").slice(0, 24)}`;
      options.consumeBudget();
      state.beginReplyChunk(deliveryKey, 0);
      try {
        await beforeAbort(options.send(uploaded, clientId, signal), signal);
      } catch (error) {
        if (error instanceof ILinkSendReceiptError && ["RejectedRet", "RejectedErrcode"].includes(error.reason)) {
          state.rejectReplyChunk(deliveryKey, 0);
        }
        throw error;
      }
      state.confirmReplyChunk(deliveryKey, 0);
      return 1;
    }, signal);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
