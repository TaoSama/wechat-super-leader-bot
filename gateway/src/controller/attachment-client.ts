import { createHash } from "node:crypto";
import { beforeAbort } from "../runtime/abort.js";
import { transferTimeoutMs } from "../runtime/transfer-budget.js";
import type { DownloadedMedia } from "../wechat/cdn-download.js";

export const ATTACHMENT_UPLOAD_SETUP_MS = 15_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MAX_ATTACHMENT_MESSAGE_ID_CHARS = 128;
const HASHED_MESSAGE_ID_PREFIX = "sha256:";

export interface StoredAttachmentReference { id: string; kind: DownloadedMedia["kind"]; name: string; size: number }

/** Stores one inbound attachment under this chat; retries with the same ordinal return the same ID. */
export async function uploadInboundAttachment(options: { baseUrl: string; token: string; fetchImpl: typeof fetch },
  request: { chatId: string; messageId: string; ordinal: number; media: DownloadedMedia }, parentSignal?: AbortSignal): Promise<StoredAttachmentReference> {
  const { media } = request;
  const controller = new AbortController();
  const signal = parentSignal ? AbortSignal.any([controller.signal, parentSignal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(new Error("Controller attachment upload timed out")),
    transferTimeoutMs(media.bytes.length, ATTACHMENT_UPLOAD_SETUP_MS));
  try {
    const url = new URL(`${options.baseUrl}/v1/inbound-attachments`);
    // WeChat client IDs can exceed the Controller's slot key limit. Reserve the hash prefix
    // so a literal short ID cannot alias a hashed long ID; other existing keys stay unchanged.
    const messageId = request.messageId.length > MAX_ATTACHMENT_MESSAGE_ID_CHARS || request.messageId.startsWith(HASHED_MESSAGE_ID_PREFIX)
      ? HASHED_MESSAGE_ID_PREFIX + createHash("sha256").update(JSON.stringify(request.messageId)).digest("hex") : request.messageId;
    for (const [key, value] of Object.entries({ chatId: request.chatId, messageId,
      ordinal: String(request.ordinal), kind: media.kind, name: media.name, mime: media.mime, sha256: media.sha256 })) {
      url.searchParams.set(key, value);
    }
    const response = await beforeAbort(options.fetchImpl(url.toString(), {
      method: "POST", redirect: "error", signal,
      headers: { "Content-Type": "application/octet-stream", Authorization: `Bearer ${options.token}` },
      body: new Uint8Array(media.bytes.buffer as ArrayBuffer, media.bytes.byteOffset, media.bytes.byteLength),
    }), signal);
    if (response.status !== 200) throw new Error(`Controller attachment upload failed HTTP ${response.status}`);
    const body = await beforeAbort(response.json() as Promise<unknown>, signal);
    const attachment = body && typeof body === "object" ? (body as Record<string, unknown>).attachment : undefined;
    const record = attachment && typeof attachment === "object" ? attachment as Record<string, unknown> : undefined;
    if (!record || typeof record.id !== "string" || !UUID.test(record.id) || record.size !== media.bytes.length ||
        record.sha256 !== media.sha256) throw new Error("Controller attachment upload returned invalid response schema");
    return { id: record.id, kind: media.kind, name: media.name, size: media.bytes.length };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
