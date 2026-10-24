import { createHash, randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { z } from "zod";
import {
  MAX_MEDIA_CHUNK_BYTES, MAX_SESSION_MEDIA, MEDIA_TIMEOUT_MS, MediaDescriptorSchema,
  MediaError, MediaListingSchema, detectImageMime,
  type MediaDescriptor, type MediaListing, type MediaTarget,
} from "./media-contracts.js";

const MAX_PENDING_MEDIA = 8;
const MAX_PENDING_PER_NODE = 2;
const MAX_WIRE_BYTES = MAX_MEDIA_CHUNK_BYTES * 2;
const MEDIA_TIMEOUT_REASON = Symbol("media_timeout");
const ListResponseSchema = z.object({
  type: z.literal("media_list"), requestId: z.string().uuid(), sessionId: z.string().min(1).max(128),
  mediaContext: z.string().uuid().optional(), source: z.enum(["control-socket", "codex-desktop"]).optional(),
  media: z.array(MediaDescriptorSchema).max(MAX_SESSION_MEDIA).optional(), error: z.string().max(128).optional(),
}).strict();
const ChunkResponseSchema = z.object({
  type: z.literal("media_chunk"), requestId: z.string().uuid(), sessionId: z.string().min(1).max(128),
  mediaContext: z.string().uuid(), mediaId: z.string().uuid(), offset: z.number().int().min(0),
  totalSize: z.number().int().min(0), mime: z.string().max(32), sha256: z.string().max(64),
  data: z.string().max(Math.ceil(MAX_MEDIA_CHUNK_BYTES / 3) * 4).optional(), eof: z.boolean(),
  error: z.string().max(128).optional(),
}).strict();
type WireResponse = z.infer<typeof ListResponseSchema> | z.infer<typeof ChunkResponseSchema>;
interface PendingMedia extends MediaTarget {
  ws: WebSocket; expectedType: "media_list" | "media_chunk";
  settle: (value?: WireResponse, error?: MediaError) => void;
}
const invalid = () => new MediaError(502, "media_invalid_response");
const disconnected = () => new MediaError(503, "media_disconnected");
const cancelled = () => new MediaError(499, "media_cancelled");
const timedOut = () => new MediaError(504, "media_timeout");
const abortError = (signal?: AbortSignal) => signal?.reason === MEDIA_TIMEOUT_REASON ? timedOut() : cancelled();
function remoteError(error: string) {
  switch (error) {
    case "Media context expired": return new MediaError(410, "media_context_expired");
    case "Media unavailable": return new MediaError(404, "media_unavailable");
    case "Too many media requests": return new MediaError(429, "media_busy");
    case "Media request timed out": return timedOut();
    default: return new MediaError(502, "media_failed");
  }
}

/** Attachment reads are separate from commands; a pending read never grants send authority. */
export class SessionMediaRequests {
  private pending = new Map<string, PendingMedia>();

  private request(target: MediaTarget, ws: WebSocket, type: "list_media" | "read_media",
    args: Record<string, unknown>, signal?: AbortSignal): Promise<WireResponse> {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    if (ws.readyState !== WebSocket.OPEN) return Promise.reject(disconnected());
    if (this.pending.size >= MAX_PENDING_MEDIA ||
        [...this.pending.values()].filter(item => item.nodeId === target.nodeId).length >= MAX_PENDING_PER_NODE) {
      return Promise.reject(new MediaError(429, "media_busy"));
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      let done = false;
      const stop = (error: MediaError) => {
        if (done) return;
        pending.settle(undefined, error);
        if (ws.readyState !== WebSocket.OPEN) return;
        try {
          ws.send(JSON.stringify({ type: "cancel_media", ...target, requestId }), error => {
            if (error) console.warn("[media] cancellation transport failed");
          });
        } catch { console.warn("[media] cancellation transport failed"); }
      };
      const onAbort = () => stop(abortError(signal));
      const timer = setTimeout(() => stop(timedOut()), MEDIA_TIMEOUT_MS);
      const pending: PendingMedia = { ...target, ws,
        expectedType: type === "list_media" ? "media_list" : "media_chunk",
        settle: (value, error) => {
          if (done) return;
          done = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort);
          this.pending.delete(requestId);
          if (error) reject(error); else if (value) resolve(value); else reject(invalid());
        },
      };
      this.pending.set(requestId, pending);
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        ws.send(JSON.stringify({ type, ...target, ...args, requestId }), error => {
          if (error) pending.settle(undefined, disconnected());
        });
      } catch { pending.settle(undefined, disconnected()); }
    });
  }

  async list(target: MediaTarget, ws: WebSocket, signal?: AbortSignal): Promise<MediaListing> {
    const response = await this.request(target, ws, "list_media", {}, signal);
    if (response.type !== "media_list") throw invalid();
    const result = MediaListingSchema.safeParse({ mediaContext: response.mediaContext, source: response.source, media: response.media ?? [] });
    if (!result.success || new Set(result.data.media.map(item => item.mediaId)).size !== result.data.media.length) throw invalid();
    return result.data;
  }

  async read(target: MediaTarget, ws: WebSocket, listing: MediaListing, image: MediaDescriptor,
    signal?: AbortSignal): Promise<Buffer> {
    const validated = MediaListingSchema.parse(listing);
    const expected = validated.media.find(item => item.mediaId === image.mediaId);
    if (!expected || JSON.stringify(expected) !== JSON.stringify(MediaDescriptorSchema.parse(image))) throw invalid();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(MEDIA_TIMEOUT_REASON), MEDIA_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const bytes = Buffer.alloc(expected.totalSize);
    let offset = 0;
    try {
      while (offset < expected.totalSize) {
        const response = await this.request(target, ws, "read_media", {
          mediaContext: validated.mediaContext, mediaId: expected.mediaId, offset,
          maxBytes: Math.min(MAX_MEDIA_CHUNK_BYTES, expected.totalSize - offset),
        }, combined);
        if (response.type !== "media_chunk" || response.mediaContext !== validated.mediaContext ||
            response.mediaId !== expected.mediaId || response.offset !== offset || response.totalSize !== expected.totalSize ||
            response.mime !== expected.mime || response.sha256 !== expected.sha256 || typeof response.data !== "string" ||
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(response.data)) throw invalid();
        const chunk = Buffer.from(response.data, "base64");
        if (!chunk.length || chunk.length > MAX_MEDIA_CHUNK_BYTES || offset + chunk.length > expected.totalSize ||
            chunk.toString("base64") !== response.data || response.eof !== (offset + chunk.length === expected.totalSize)) throw invalid();
        chunk.copy(bytes, offset); offset += chunk.length;
      }
      if (combined.aborted) throw abortError(combined);
      if (createHash("sha256").update(bytes).digest("hex") !== expected.sha256 || detectImageMime(bytes) !== expected.mime) throw invalid();
      return bytes;
    } finally { clearTimeout(timer); }
  }

  receive(nodeId: string, ws: WebSocket, raw: unknown): boolean {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const envelope = raw as Record<string, unknown>;
    if (typeof envelope.requestId !== "string") return false;
    const pending = this.pending.get(envelope.requestId);
    if (!pending || pending.ws !== ws || pending.nodeId !== nodeId || pending.sessionId !== envelope.sessionId) return false;
    if (JSON.stringify(raw).length > MAX_WIRE_BYTES) { pending.settle(undefined, invalid()); return false; }
    const parsed = pending.expectedType === "media_list" ? ListResponseSchema.safeParse(raw) : ChunkResponseSchema.safeParse(raw);
    if (!parsed.success) { pending.settle(undefined, invalid()); return false; }
    if (parsed.data.error !== undefined) pending.settle(undefined, remoteError(parsed.data.error));
    else pending.settle(parsed.data);
    return true;
  }

  disconnect(ws: WebSocket) { for (const item of [...this.pending.values()]) if (item.ws === ws) item.settle(undefined, disconnected()); }
  closeAll() { for (const item of [...this.pending.values()]) item.settle(undefined, disconnected()); }
}
