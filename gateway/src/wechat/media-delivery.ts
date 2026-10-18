import { createHash } from "node:crypto";
import type { StateManager } from "../runtime/state.js";
import { ILinkSendReceiptError } from "./send-receipt.js";
import { MAX_IMAGE_BYTES, MAX_REPLY_IMAGES, validateImageBytes, type ImageMime, type UploadedImageItem } from "./media-upload.js";
import { beforeAbort } from "../runtime/abort.js";

export interface ImageAttachment { id: string; mime: ImageMime; size: number; sha256: string }
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_IMAGE_ID_CHARS = 128;

export function validateImageAttachments(value: unknown): ImageAttachment[] {
  if (!Array.isArray(value) || value.length > MAX_REPLY_IMAGES) throw new Error("Invalid WeChat image attachment list");
  const ids = new Set<string>();
  return value.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid WeChat image attachment");
    const image = item as Record<string, unknown>;
    if (Object.keys(image).some(key => !["id", "mime", "size", "sha256"].includes(key)) ||
        typeof image.id !== "string" || !image.id || image.id.length > MAX_IMAGE_ID_CHARS ||
        image.id === "." || image.id === ".." ||
        /[\u0000-\u0020\u007f]/u.test(image.id) || ids.has(image.id) ||
        typeof image.mime !== "string" || !IMAGE_MIMES.has(image.mime) ||
        typeof image.size !== "number" || !Number.isSafeInteger(image.size) || image.size <= 0 || image.size > MAX_IMAGE_BYTES ||
        typeof image.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(image.sha256)) {
      throw new Error("Invalid WeChat image attachment metadata");
    }
    ids.add(image.id);
    return { id: image.id, mime: image.mime as ImageMime, size: image.size, sha256: image.sha256 };
  });
}

export async function sendImageReply(options: {
  stateManager: StateManager;
  chatId: string;
  deliveryKey: string;
  images: ImageAttachment[];
  getImageBytes: (image: ImageAttachment, signal?: AbortSignal) => Promise<Buffer>;
  uploadImage: (bytes: Buffer, signal?: AbortSignal) => Promise<UploadedImageItem>;
  sendImage: (item: UploadedImageItem, clientId: string, signal?: AbortSignal) => Promise<void>;
  beforeBeginChunk?: () => void;
  signal?: AbortSignal;
  shouldContinue?: () => boolean;
}): Promise<number> {
  const images = validateImageAttachments(options.images);
  if (images.length === 0) return 0;
  if (!options.chatId.trim() || !options.deliveryKey.trim()) throw new Error("WeChat image delivery requires stable identity");
  options.signal?.throwIfAborted();
  const { stateManager, chatId, deliveryKey } = options;
  const signal = options.signal ?? new AbortController().signal;
  const digest = createHash("sha256").update(JSON.stringify([
    stateManager.getLoginFingerprint(), chatId, "images-v1", images,
  ])).digest("hex");
  const delivery = stateManager.prepareReplyDelivery(deliveryKey, digest, images.length);
  for (let index = delivery.acknowledgedChunks; index < images.length; index++) {
    signal?.throwIfAborted();
    if (options.shouldContinue && !options.shouldContinue()) throw new Error("WeChat image reply interrupted before completion");
    const image = images[index];
    const downloaded = await beforeAbort(options.getImageBytes(image, signal), signal);
    signal?.throwIfAborted();
    if (!Buffer.isBuffer(downloaded)) throw new Error("WeChat image download returned invalid bytes");
    const bytes = Buffer.from(downloaded);
    if (bytes.length !== image.size || validateImageBytes(bytes) !== image.mime ||
        createHash("sha256").update(bytes).digest("hex") !== image.sha256) {
      throw new Error("WeChat image bytes do not match the attachment metadata");
    }
    if (options.shouldContinue && !options.shouldContinue()) throw new Error("WeChat image reply interrupted before upload");
    const uploaded = await beforeAbort(options.uploadImage(bytes, signal), signal);
    signal?.throwIfAborted();
    if (options.shouldContinue && !options.shouldContinue()) throw new Error("WeChat image reply interrupted before completion");
    const clientId = `super-leader:image:${createHash("sha256").update(JSON.stringify([
      stateManager.getLoginFingerprint(), chatId, deliveryKey, index,
    ])).digest("hex").slice(0, 24)}`;
    // Only sendmessage has an uncertain delivery outcome; a failed upload can safely be repeated.
    options.beforeBeginChunk?.();
    stateManager.beginReplyChunk(deliveryKey, index);
    try {
      await beforeAbort(options.sendImage(uploaded, clientId, signal), signal);
    } catch (error) {
      if (error instanceof ILinkSendReceiptError &&
          (error.reason === "RejectedRet" || error.reason === "RejectedErrcode")) {
        stateManager.rejectReplyChunk(deliveryKey, index);
      }
      throw error;
    }
    stateManager.confirmReplyChunk(deliveryKey, index);
  }
  return images.length;
}
