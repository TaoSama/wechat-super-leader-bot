import { CdnUploader, MEDIA_UPLOAD_TIMEOUT_MS, type UploadRequest } from "./cdn-upload.js";

export type { UploadRequest } from "./cdn-upload.js";
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_REPLY_IMAGES = 3;
export const IMAGE_UPLOAD_TIMEOUT_MS = MEDIA_UPLOAD_TIMEOUT_MS;

export type ImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
export interface UploadedImageItem {
  type: 2;
  image_item: {
    media: { encrypt_query_param: string; aes_key: string; encrypt_type: 1 };
    mid_size: number;
  };
}

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

export class ImageUploader {
  private readonly uploader: CdnUploader;

  constructor(options: { request: UploadRequest; fetchImpl?: typeof fetch; timeoutMs?: number }) {
    this.uploader = new CdnUploader({ ...options, label: "image" });
  }

  public async upload(chatId: string, bytes: Buffer, parentSignal?: AbortSignal): Promise<UploadedImageItem> {
    validateImageBytes(bytes);
    const uploaded = await this.uploader.upload(chatId, bytes, 1, parentSignal);
    return { type: 2, image_item: { media: uploaded.media, mid_size: uploaded.ciphertextBytes } };
  }
}
