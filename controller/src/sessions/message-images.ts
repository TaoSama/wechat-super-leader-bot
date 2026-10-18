import { createHash, randomUUID } from "node:crypto";
import {
  MAX_MEDIA_BYTES, MAX_SESSION_MEDIA, MediaError, ReplyImagesSchema, detectImageMime,
  type MediaDescriptor, type MediaListing, type MediaTarget, type ReplyImage,
} from "./media-contracts.js";

export const MESSAGE_IMAGE_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_STORED_IMAGE_BYTES = 128 * 1024 * 1024;
export const MAX_STORED_MESSAGE_IMAGES = 1024;
export interface StoredMessageImage extends ReplyImage { data: Buffer }
export interface MessageImageStore {
  recordMessageImages(chatId: string, messageId: string, images: StoredMessageImage[], expiresAt: number): Promise<ReplyImage[]>;
  getMessageImage(chatId: string, messageId: string, imageId: string, now: number): Promise<StoredMessageImage | null>;
}
export interface MediaHub {
  listMedia(nodeId: string, sessionId: string, signal?: AbortSignal): Promise<MediaListing>;
  readMedia(nodeId: string, sessionId: string, listing: MediaListing, image: MediaDescriptor, signal?: AbortSignal): Promise<Buffer>;
}

export function validateStoredImages(images: StoredMessageImage[]): void {
  const descriptors = ReplyImagesSchema.parse(images.map(({ data: _data, ...image }) => image));
  if (new Set(descriptors.map(image => image.id)).size !== images.length) throw new MediaError(400, "media_invalid_images");
  for (const image of images) {
    if (!Buffer.isBuffer(image.data) || image.data.length !== image.size || image.data.length > MAX_MEDIA_BYTES ||
        detectImageMime(image.data) !== image.mime || createHash("sha256").update(image.data).digest("hex") !== image.sha256) {
      throw new MediaError(400, "media_invalid_images");
    }
  }
}

/** Freeze verified original bytes before returning attachment IDs to the Gateway. */
export async function prepareMessageImages(hub: MediaHub, store: MessageImageStore,
  chatId: string, messageId: string, target: MediaTarget, signal: AbortSignal,
  now: () => number = Date.now): Promise<{ images: ReplyImage[]; source: MediaListing["source"] }> {
  signal.throwIfAborted();
  const listing = await hub.listMedia(target.nodeId, target.sessionId, signal);
  if (listing.media.length === 0) throw new MediaError(404, "media_unavailable");
  if (listing.media.length > MAX_SESSION_MEDIA) throw new MediaError(502, "media_invalid_response");
  const images: StoredMessageImage[] = [];
  for (const media of listing.media) {
    const data = await hub.readMedia(target.nodeId, target.sessionId, listing, media, signal);
    signal.throwIfAborted();
    images.push({ id: randomUUID(), mime: media.mime, size: media.totalSize, sha256: media.sha256, data });
  }
  validateStoredImages(images);
  const references = await store.recordMessageImages(chatId, messageId, images, now() + MESSAGE_IMAGE_TTL_MS);
  signal.throwIfAborted();
  return { images: references, source: listing.source };
}

/** Test/runtime in-memory store. PostgreSQL stores exactly the same immutable records. */
export class MemoryMessageImages implements MessageImageStore {
  private images = new Map<string, { expiresAt: number; images: StoredMessageImage[] }>();
  constructor(private now: () => number = Date.now) {}
  async recordMessageImages(chatId: string, messageId: string, images: StoredMessageImage[], expiresAt: number): Promise<ReplyImage[]> {
    validateStoredImages(images);
    const key = JSON.stringify([chatId, messageId]);
    const existing = this.images.get(key);
    if (existing) {
      if (existing.expiresAt <= this.now()) throw new MediaError(410, "media_expired");
      if (JSON.stringify(existing.images.map(({ id: _id, data: _data, ...item }) => item)) !==
          JSON.stringify(images.map(({ id: _id, data: _data, ...item }) => item))) throw new MediaError(409, "media_message_conflict");
      return existing.images.map(({ data: _data, ...item }) => ({ ...item }));
    }
    for (const [entryKey, entry] of this.images) if (entry.expiresAt <= this.now()) this.images.delete(entryKey);
    const used = [...this.images.values()].reduce((total, entry) => total + entry.images.reduce((sum, image) => sum + image.size, 0), 0);
    const count = [...this.images.values()].reduce((total, entry) => total + entry.images.length, 0);
    if (count + images.length > MAX_STORED_MESSAGE_IMAGES ||
        used + images.reduce((total, image) => total + image.size, 0) > MAX_STORED_IMAGE_BYTES) throw new MediaError(429, "media_storage_full");
    this.images.set(key, { expiresAt, images: images.map(image => ({ ...image, data: Buffer.from(image.data) })) });
    return images.map(({ data: _data, ...item }) => ({ ...item }));
  }
  async getMessageImage(chatId: string, messageId: string, imageId: string, now: number): Promise<StoredMessageImage | null> {
    const entry = this.images.get(JSON.stringify([chatId, messageId]));
    if (!entry || entry.expiresAt <= now) return null;
    const image = entry.images.find(image => image.id === imageId);
    return image ? { ...image, data: Buffer.from(image.data) } : null;
  }
}
