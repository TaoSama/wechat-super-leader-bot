import { createHash } from "node:crypto";
import { CdnUploader, type UploadedCdnMedia, type UploadRequest } from "./cdn-upload.js";

// Product default; deployments may choose a different limit.
export const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_FILE_NAME_BYTES = 255;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export interface FileUploadMetadata {
  fileName: string;
  byteLength: number;
  sha256: string;
}

export interface UploadedFileItem {
  type: 4;
  file_item: { media: UploadedCdnMedia["media"]; file_name: string; len: string };
}

export class FileUploader {
  private readonly uploader: CdnUploader;
  private readonly maxFileBytes: number;

  constructor(options: { request: UploadRequest; fetchImpl?: typeof fetch; timeoutMs?: number;
    maxFileBytes?: number }) {
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    if (!Number.isSafeInteger(this.maxFileBytes) || this.maxFileBytes <= 0) {
      throw new Error("Invalid WeChat file byte limit");
    }
    this.uploader = new CdnUploader({ ...options, label: "file" });
  }

  /** Accept only the bytes and integrity metadata obtained through the trusted artifact client. */
  public async upload(chatId: string, bytes: Buffer, metadata: FileUploadMetadata,
    parentSignal?: AbortSignal): Promise<UploadedFileItem> {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > this.maxFileBytes) {
      throw new Error("WeChat file exceeds the configured byte limit or is empty");
    }
    if (!metadata || typeof metadata.fileName !== "string" || !metadata.fileName.trim() ||
        metadata.fileName === "." || metadata.fileName === ".." ||
        /[\u0000-\u001f\u007f/\\]/u.test(metadata.fileName) ||
        Buffer.byteLength(metadata.fileName, "utf8") > MAX_FILE_NAME_BYTES) {
      throw new Error("WeChat file requires a valid file name without a path");
    }
    if (!Number.isSafeInteger(metadata.byteLength) || metadata.byteLength !== bytes.length ||
        typeof metadata.sha256 !== "string" || !SHA256_PATTERN.test(metadata.sha256) ||
        createHash("sha256").update(bytes).digest("hex") !== metadata.sha256) {
      throw new Error("WeChat file bytes do not match artifact integrity metadata");
    }
    const fileName = metadata.fileName;
    const uploaded = await this.uploader.upload(chatId, bytes, 3, parentSignal);
    return { type: 4, file_item: { media: uploaded.media, file_name: fileName,
      len: String(uploaded.plaintextBytes) } };
  }
}
