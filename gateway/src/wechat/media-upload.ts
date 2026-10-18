import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { beforeAbort } from "../runtime/abort.js";

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_REPLY_IMAGES = 3;
export const IMAGE_UPLOAD_TIMEOUT_MS = 30_000;
const MAX_UPLOAD_ATTEMPTS = 3;
const CDN_UPLOAD_URL = "https://novac2c.cdn.weixin.qq.com/c2c/upload";
const AES_BLOCK_BYTES = 16;
const MAX_DOWNLOAD_PARAM_CHARS = 8192;

export type ImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
export interface UploadedImageItem {
  type: 2;
  image_item: {
    media: { encrypt_query_param: string; aes_key: string; encrypt_type: 1 };
    mid_size: number;
  };
}

export type UploadRequest = (endpoint: string, payload: Record<string, unknown>, timeoutMs: number,
  signal?: AbortSignal) => Promise<Record<string, unknown>>;

export function validateImageBytes(bytes: Buffer): ImageMime {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
    throw new Error("WeChat image must be a Buffer between 1 byte and 8 MiB");
  }
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  const signature = bytes.subarray(0, 6).toString("ascii");
  if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  throw new Error("WeChat image has an unsupported file signature");
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

export class ImageUploader {
  private readonly request: UploadRequest;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: { request: UploadRequest; fetchImpl?: typeof fetch; timeoutMs?: number }) {
    this.request = options.request;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? IMAGE_UPLOAD_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > IMAGE_UPLOAD_TIMEOUT_MS) {
      throw new Error("Invalid WeChat image upload timeout budget");
    }
  }

  public async upload(chatId: string, bytes: Buffer, parentSignal?: AbortSignal): Promise<UploadedImageItem> {
    validateImageBytes(bytes);
    if (!chatId.trim()) throw new Error("WeChat image requires a chat ID");
    parentSignal?.throwIfAborted();
    // Capture the caller's bytes before yielding so hashes and ciphertext describe the same image.
    const plaintext = Buffer.from(bytes);
    const key = randomBytes(AES_BLOCK_BYTES);
    const keyHex = key.toString("hex");
    const filekey = randomBytes(AES_BLOCK_BYTES).toString("hex");
    const cipher = createCipheriv("aes-128-ecb", key, null);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const controller = new AbortController();
    const signal = parentSignal ? AbortSignal.any([controller.signal, parentSignal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(new Error("WeChat image upload timed out")), this.timeoutMs);
    try {
      const response = await beforeAbort(this.request("ilink/bot/getuploadurl", {
        filekey, media_type: 1, to_user_id: chatId, rawsize: plaintext.length,
        rawfilemd5: createHash("md5").update(plaintext).digest("hex"),
        filesize: Math.floor(plaintext.length / AES_BLOCK_BYTES + 1) * AES_BLOCK_BYTES,
        no_need_thumb: true, aeskey: keyHex,
      }, this.timeoutMs, signal), signal);
      signal.throwIfAborted();
      for (const field of ["ret", "errcode"] as const) {
        if (Object.hasOwn(response, field) && response[field] !== 0) {
          throw new Error("WeChat image upload authorization rejected");
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
        throw new Error("WeChat image upload authorization is missing a URL");
      }
      for (let attempt = 0; attempt < MAX_UPLOAD_ATTEMPTS; attempt++) {
        signal.throwIfAborted();
        try {
          let uploaded: Response;
          try {
            uploaded = await beforeAbort(this.fetchImpl(uploadUrl, {
              method: "POST", headers: { "Content-Type": "application/octet-stream" },
              body: new Uint8Array(ciphertext), redirect: "error", signal,
            }), signal);
          } catch {
            signal.throwIfAborted();
            throw new UploadFailure("WeChat CDN upload request failed", true);
          }
          signal.throwIfAborted();
          if (uploaded.status !== 200) {
            throw new UploadFailure(`WeChat CDN upload failed HTTP ${uploaded.status}`,
              uploaded.status >= 500);
          }
          const downloadParam = uploaded.headers.get("x-encrypted-param");
          if (!downloadParam || !downloadParam.trim() || downloadParam.length > MAX_DOWNLOAD_PARAM_CHARS ||
              /[\u0000-\u001f\u007f]/u.test(downloadParam)) {
            throw new UploadFailure("WeChat CDN upload is missing a valid download parameter", true);
          }
          return { type: 2, image_item: { media: {
            encrypt_query_param: downloadParam, aes_key: Buffer.from(keyHex).toString("base64"), encrypt_type: 1,
          }, mid_size: ciphertext.length } };
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
