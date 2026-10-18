import { z } from "zod";

export const MAX_MEDIA_BYTES = 8 * 1024 * 1024;
export const MAX_MEDIA_CHUNK_BYTES = 192 * 1024;
export const MAX_SESSION_MEDIA = 3;
export const MEDIA_TIMEOUT_MS = 15000;
export const MediaMimeSchema = z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const MediaHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const MediaDescriptorSchema = z.object({
  mediaId: z.string().uuid(), itemId: z.string().min(1).max(128),
  turnId: z.string().min(1).max(128), ordinal: z.number().int().min(0).max(255),
  mime: MediaMimeSchema, totalSize: z.number().int().positive().max(MAX_MEDIA_BYTES), sha256: MediaHashSchema,
}).strict();
export type MediaDescriptor = z.infer<typeof MediaDescriptorSchema>;
export const MediaListingSchema = z.object({
  mediaContext: z.string().uuid(), source: z.enum(["control-socket", "codex-desktop"]),
  media: z.array(MediaDescriptorSchema).max(MAX_SESSION_MEDIA),
}).strict();
export type MediaListing = z.infer<typeof MediaListingSchema>;
export const ReplyImageSchema = z.object({
  id: z.string().uuid(), mime: MediaMimeSchema,
  size: z.number().int().positive().max(MAX_MEDIA_BYTES), sha256: MediaHashSchema,
}).strict();
export const ReplyImagesSchema = z.array(ReplyImageSchema).min(1).max(MAX_SESSION_MEDIA);
export type ReplyImage = z.infer<typeof ReplyImageSchema>;
export type MediaTarget = { nodeId: string; sessionId: string };

export class MediaError extends Error {
  constructor(public readonly httpStatus: number, public readonly code: string) {
    super(code); this.name = "MediaError";
  }
}

export function detectImageMime(bytes: Uint8Array): z.infer<typeof MediaMimeSchema> | undefined {
  const buffer = Buffer.from(bytes);
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return "image/jpeg";
  if (buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}
