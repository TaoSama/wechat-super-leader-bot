import { createDecipheriv, createHash } from "node:crypto";
import * as path from "node:path";
import { beforeAbort } from "../runtime/abort.js";
import { transferTimeoutMs } from "../runtime/transfer-budget.js";
import type { InboundMediaKind, InboundMediaRef } from "../types.js";
import { MAX_MEDIA_FILE_NAME_CHARS } from "./inbound-content.js";
import { sniffImageMime } from "./media-upload.js";

export const MAX_INBOUND_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_INBOUND_FILE_BYTES = 20 * 1024 * 1024;
export const MEDIA_DOWNLOAD_SETUP_MS = 15_000;
const CDN_DOWNLOAD_URL = "https://novac2c.cdn.weixin.qq.com/c2c/download";
const CDN_HOST_SUFFIX = ".weixin.qq.com";
const AES_BLOCK_BYTES = 16;
const DEFAULT_IMAGE_NAME = "image";
const DEFAULT_FILE_NAME = "attachment";
const FALLBACK_FILE_MIME = "application/octet-stream";

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp",
};
const FILE_MIMES: Record<string, string> = {
  ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv",
  ".json": "application/json", ".zip": "application/zip", ".log": "text/plain",
  ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
};

export interface DownloadedMedia {
  kind: InboundMediaKind;
  name: string;
  mime: string;
  bytes: Buffer;
  sha256: string;
}

export class MediaDownloadError extends Error {
  constructor(message: string) { super(message); this.name = "MediaDownloadError"; }
}

export const maxMediaBytes = (kind: InboundMediaKind) => kind === "image" ? MAX_INBOUND_IMAGE_BYTES : MAX_INBOUND_FILE_BYTES;

/** Keeps a display-safe base name; the daemon still chooses its own file path. */
export function safeFileName(raw: string | undefined, fallback: string): string {
  const base = path.posix.basename((raw ?? "").replace(/\\/gu, "/")).replace(/[\u0000-\u001f\u007f"<>|:*?]/gu, "_").trim();
  const name = base && base !== "." && base !== ".." ? base : fallback;
  return name.length > MAX_MEDIA_FILE_NAME_CHARS ? name.slice(name.length - MAX_MEDIA_FILE_NAME_CHARS) : name;
}

export function decryptAes128Ecb(ciphertext: Buffer, keyHex: string): Buffer {
  if (!/^[0-9a-f]{32}$/u.test(keyHex)) throw new MediaDownloadError("WeChat media key is invalid");
  if (ciphertext.length === 0 || ciphertext.length % AES_BLOCK_BYTES !== 0) {
    throw new MediaDownloadError("WeChat media ciphertext is not block aligned");
  }
  try {
    const decipher = createDecipheriv("aes-128-ecb", Buffer.from(keyHex, "hex"), null);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new MediaDownloadError("WeChat media decryption failed");
  }
}

/** Server URLs are accepted only on the WeChat CDN; otherwise the query parameter route is used. */
export function mediaDownloadUrl(ref: Pick<InboundMediaRef, "fullUrl" | "encryptQueryParam">): string {
  if (ref.fullUrl) {
    try {
      const url = new URL(ref.fullUrl);
      if (url.protocol === "https:" && url.hostname.endsWith(CDN_HOST_SUFFIX) && !url.port && !url.username &&
          !url.password && !url.hash) return url.toString();
    } catch { /* Fall through to the parameter route below. */ }
  }
  if (!ref.encryptQueryParam) throw new MediaDownloadError("WeChat media download URL is not allowed");
  const url = new URL(CDN_DOWNLOAD_URL);
  url.searchParams.set("encrypted_query_param", ref.encryptQueryParam);
  return url.toString();
}

function fileMime(name: string, bytes: Buffer): string {
  const sniffed = sniffImageMime(bytes);
  if (sniffed) return sniffed;
  return FILE_MIMES[path.extname(name).toLowerCase()] ?? FALLBACK_FILE_MIME;
}

async function readBounded(response: Response, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > maxBytes)) {
    throw new MediaDownloadError("WeChat media exceeds the size limit");
  }
  if (!response.body) throw new MediaDownloadError("WeChat media download has no body");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await beforeAbort(reader.read(), signal);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) throw new MediaDownloadError("WeChat media exceeds the size limit");
      chunks.push(Buffer.from(next.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

/** Downloads, decrypts and validates one inbound attachment within its kind's size cap. */
export async function downloadInboundMedia(ref: InboundMediaRef, options: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {}): Promise<DownloadedMedia> {
  const maxBytes = maxMediaBytes(ref.kind);
  // PKCS7 adds at most one block to the plaintext.
  const maxCiphertext = ref.aesKeyHex ? maxBytes + AES_BLOCK_BYTES : maxBytes;
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(new MediaDownloadError(`WeChat ${ref.kind} download timed out`)),
    transferTimeoutMs(maxCiphertext, MEDIA_DOWNLOAD_SETUP_MS));
  try {
    const url = mediaDownloadUrl(ref);
    let response: Response;
    try {
      response = await beforeAbort((options.fetchImpl ?? globalThis.fetch)(url, { method: "GET", redirect: "error", signal }), signal);
    } catch (error) {
      signal.throwIfAborted();
      throw error instanceof MediaDownloadError ? error : new MediaDownloadError("WeChat media download request failed");
    }
    if (response.status !== 200) throw new MediaDownloadError(`WeChat media download failed HTTP ${response.status}`);
    const raw = await readBounded(response, maxCiphertext, signal);
    const bytes = ref.aesKeyHex ? decryptAes128Ecb(raw, ref.aesKeyHex) : raw;
    if (bytes.length === 0 || bytes.length > maxBytes) throw new MediaDownloadError("WeChat media exceeds the size limit");
    let mime: string;
    let name: string;
    if (ref.kind === "image") {
      const sniffed = sniffImageMime(bytes);
      if (!sniffed) throw new MediaDownloadError("WeChat image has an unsupported format");
      mime = sniffed;
      name = `${DEFAULT_IMAGE_NAME}${IMAGE_EXTENSIONS[sniffed]}`;
    } else {
      name = safeFileName(ref.fileName, DEFAULT_FILE_NAME);
      mime = fileMime(name, bytes);
    }
    return { kind: ref.kind, name, mime, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
