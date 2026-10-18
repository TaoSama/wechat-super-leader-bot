import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { transferTimeoutMs } from "../runtime/transfer-budget.js";
import { beforeAbort } from "../runtime/abort.js";

export const MEDIA_UPLOAD_TIMEOUT_MS = 30_000;
const MAX_UPLOAD_ATTEMPTS = 3;
const CDN_UPLOAD_URL = "https://novac2c.cdn.weixin.qq.com/c2c/upload";
const AES_BLOCK_BYTES = 16;
const MAX_DOWNLOAD_PARAM_CHARS = 8192;

export type UploadRequest = (endpoint: string, payload: Record<string, unknown>, timeoutMs: number,
  signal?: AbortSignal) => Promise<Record<string, unknown>>;
export interface UploadedCdnMedia {
  media: { encrypt_query_param: string; aes_key: string; encrypt_type: 1 };
  plaintextBytes: number;
  ciphertextBytes: number;
}

function validateUploadUrl(value: string): string {
  const invalid = () => new Error("WeChat CDN upload URL is not allowed");
  if (/[\u0000-\u0020\u007f\\]/u.test(value)) throw invalid();
  let url: URL;
  try { url = new URL(value); } catch { throw invalid(); }
  if (url.protocol !== "https:" || url.hostname !== "novac2c.cdn.weixin.qq.com" ||
      url.pathname !== "/c2c/upload" || url.port || url.username || url.password || url.hash) throw invalid();
  return url.toString();
}

class UploadFailure extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message); }
}

/** Uploading media alone does not send a chat message or consume a message reservation. */
export class CdnUploader {
  private readonly request: UploadRequest;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs?: number;
  private readonly label: "image" | "file";

  constructor(options: { request: UploadRequest; fetchImpl?: typeof fetch; timeoutMs?: number;
    label: "image" | "file" }) {
    this.request = options.request;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs;
    this.label = options.label;
    if (this.timeoutMs !== undefined && (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > MEDIA_UPLOAD_TIMEOUT_MS)) {
      throw new Error(`Invalid WeChat ${this.label} upload timeout budget`);
    }
  }

  public async upload(chatId: string, bytes: Buffer, mediaType: 1 | 3,
    parentSignal?: AbortSignal): Promise<UploadedCdnMedia> {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new Error("WeChat media requires non-empty bytes");
    if (typeof chatId !== "string" || !chatId.trim()) throw new Error(`WeChat ${this.label} requires a chat ID`);
    parentSignal?.throwIfAborted();
    // Capture hashes and encrypt before yielding, without retaining a second plaintext buffer.
    const plaintextBytes = bytes.length;
    const plaintextMd5 = createHash("md5").update(bytes).digest("hex");
    const key = randomBytes(AES_BLOCK_BYTES);
    const keyHex = key.toString("hex");
    const filekey = randomBytes(AES_BLOCK_BYTES).toString("hex");
    const cipher = createCipheriv("aes-128-ecb", key, null);
    const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
    const timeoutMs = this.timeoutMs ?? (this.label === "file"
      ? transferTimeoutMs(plaintextBytes, MEDIA_UPLOAD_TIMEOUT_MS) : MEDIA_UPLOAD_TIMEOUT_MS);
    const controller = new AbortController();
    const signal = parentSignal ? AbortSignal.any([controller.signal, parentSignal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(new Error(`WeChat ${this.label} upload timed out`)), timeoutMs);
    try {
      const authorization = new AbortController();
      const authorizationSignal = AbortSignal.any([signal, authorization.signal]);
      const authorizationTimeoutMs = Math.min(timeoutMs, MEDIA_UPLOAD_TIMEOUT_MS);
      const authorizationTimer = setTimeout(() => authorization.abort(
        new Error(`WeChat ${this.label} upload authorization timed out`)), authorizationTimeoutMs);
      let response: Record<string, unknown>;
      try {
        response = await beforeAbort(this.request("ilink/bot/getuploadurl", {
          filekey, media_type: mediaType, to_user_id: chatId, rawsize: plaintextBytes,
          rawfilemd5: plaintextMd5,
          filesize: ciphertext.length, no_need_thumb: true, aeskey: keyHex,
        }, authorizationTimeoutMs, authorizationSignal), authorizationSignal);
      } finally { clearTimeout(authorizationTimer); authorization.abort(); }
      signal.throwIfAborted();
      for (const field of ["ret", "errcode"] as const) {
        if (Object.hasOwn(response, field) && response[field] !== 0) {
          throw new Error(`WeChat ${this.label} upload authorization rejected`);
        }
      }
      let uploadUrl: string;
      if (typeof response.upload_full_url === "string" && response.upload_full_url.trim()) {
        uploadUrl = validateUploadUrl(response.upload_full_url.trim());
      } else if (typeof response.upload_param === "string" && response.upload_param) {
        const url = new URL(CDN_UPLOAD_URL);
        url.searchParams.set("encrypted_query_param", response.upload_param);
        url.searchParams.set("filekey", filekey);
        uploadUrl = url.toString();
      } else {
        throw new Error(`WeChat ${this.label} upload authorization is missing a URL`);
      }
      for (let attempt = 0; attempt < MAX_UPLOAD_ATTEMPTS; attempt++) {
        signal.throwIfAborted();
        try {
          let uploaded: Response;
          try {
            uploaded = await beforeAbort(this.fetchImpl(uploadUrl, {
              method: "POST", headers: { "Content-Type": "application/octet-stream" },
              body: new Uint8Array(ciphertext.buffer as ArrayBuffer, ciphertext.byteOffset, ciphertext.byteLength), redirect: "error", signal,
            }), signal);
          } catch {
            signal.throwIfAborted();
            throw new UploadFailure("WeChat CDN upload request failed", true);
          }
          signal.throwIfAborted();
          if (uploaded.status !== 200) {
            throw new UploadFailure(`WeChat CDN upload failed HTTP ${uploaded.status}`, uploaded.status >= 500);
          }
          const downloadParam = uploaded.headers.get("x-encrypted-param");
          if (!downloadParam || !downloadParam.trim() || downloadParam.length > MAX_DOWNLOAD_PARAM_CHARS ||
              /[\u0000-\u001f\u007f]/u.test(downloadParam)) {
            throw new UploadFailure("WeChat CDN upload is missing a valid download parameter", true);
          }
          return { media: { encrypt_query_param: downloadParam,
            aes_key: Buffer.from(keyHex).toString("base64"), encrypt_type: 1 },
          plaintextBytes, ciphertextBytes: ciphertext.length };
        } catch (error) {
          signal.throwIfAborted();
          if (!(error instanceof UploadFailure) || !error.retryable || attempt === MAX_UPLOAD_ATTEMPTS - 1) throw error;
        }
      }
      throw new Error("WeChat CDN upload failed");
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
}
