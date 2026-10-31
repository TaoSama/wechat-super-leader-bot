import { createHash } from "node:crypto";
import { validateImageAttachments, type ImageAttachment } from "../wechat/media-delivery.js";
import { validateImageBytes } from "../wechat/media-upload.js";
import { beforeAbort } from "../runtime/abort.js";
import { RequestDiagnostics } from "../runtime/request-diagnostics.js";

export const IMAGE_DOWNLOAD_TIMEOUT_MS = 15_000;

export class PermanentImageDownloadError extends Error {
  constructor(public readonly reason: "AttachmentExpired" | "AttachmentUnavailable") {
    super(`Controller image download permanently failed: ${reason}`);
    this.name = "PermanentImageDownloadError";
  }
}

export async function downloadControllerImage(options: {
  baseUrl: string; token: string; fetchImpl: typeof fetch; timeoutMs: number;
}, request: { chatId: string; messageId: string; image: ImageAttachment }, parentSignal?: AbortSignal): Promise<Buffer> {
  const [image] = validateImageAttachments([request.image]);
  if (!request.chatId.trim() || !request.messageId.trim() || [".", ".."].includes(request.messageId)) {
    throw new Error("Invalid Controller image identity");
  }
  const controller = new AbortController();
  const signal = parentSignal ? AbortSignal.any([controller.signal, parentSignal]) : controller.signal;
  signal.throwIfAborted();
  const timer = setTimeout(() => controller.abort(new Error("Controller image download timed out")),
    Math.min(options.timeoutMs, IMAGE_DOWNLOAD_TIMEOUT_MS));
  const diagnostics = new RequestDiagnostics("image_download", JSON.stringify([request.chatId, request.messageId, image.id]));
  try {
    const url = `${options.baseUrl}/v1/messages/${encodeURIComponent(request.messageId)}/images/${encodeURIComponent(image.id)}` +
      `?chatId=${encodeURIComponent(request.chatId)}`;
    const response = await beforeAbort(options.fetchImpl(url, {
      method: "GET", headers: { Authorization: `Bearer ${options.token}` }, redirect: "error", signal,
    }), signal);
    diagnostics.phase = "headers";
    diagnostics.httpStatus = response.status;
    signal.throwIfAborted();
    if (response.status === 410) throw new PermanentImageDownloadError("AttachmentExpired");
    if (response.status === 404) throw new PermanentImageDownloadError("AttachmentUnavailable");
    if (response.status !== 200) throw new Error(`Controller image download failed HTTP ${response.status}`);
    if (response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== image.mime || !response.body) {
      throw new Error("Controller image download returned invalid content type or body");
    }
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) !== image.size)) {
      throw new Error("Controller image download returned invalid content length");
    }
    diagnostics.phase = "body";
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for (;;) {
        const next = await beforeAbort(reader.read(), signal);
        signal.throwIfAborted();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > image.size) throw new Error("Controller image download exceeds attachment size");
        chunks.push(Buffer.from(next.value));
      }
    } finally { reader.releaseLock(); }
    const bytes = Buffer.concat(chunks);
    if (size !== image.size || createHash("sha256").update(bytes).digest("hex") !== image.sha256 ||
        validateImageBytes(bytes) !== image.mime) throw new Error("Controller image download failed integrity validation");
    diagnostics.success();
    return bytes;
  } catch (error) {
    diagnostics.failure(error, 1, 1, controller.signal.aborted, Boolean(parentSignal?.aborted));
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
