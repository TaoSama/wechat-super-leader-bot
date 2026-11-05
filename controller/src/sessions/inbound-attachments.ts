import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { MediaError, MediaMimeSchema, detectImageMime } from "./media-contracts.js";

/** Stored bytes outlive the reference window so frozen plan steps can still dispatch within a day. */
export const INBOUND_ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;
/** A new tool call may only reference attachments received in this chat within this window. */
export const ATTACHMENT_REFERENCE_WINDOW_MS = 30 * 60 * 1000;
export const MAX_INBOUND_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_INBOUND_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_STORED_ATTACHMENT_BYTES = 256 * 1024 * 1024;
export const MAX_STORED_ATTACHMENTS = 512;
export const MAX_CONTEXT_ATTACHMENTS = 5;
// Matches the Gateway's per-message cap, so one message's attachments fit one command.
export const MAX_ATTACHMENTS_PER_MESSAGE = 3;
export const MAX_COMMAND_ATTACHMENTS = MAX_ATTACHMENTS_PER_MESSAGE;
export const MAX_ATTACHMENT_NAME_CHARS = 255;

export const AttachmentKindSchema = z.enum(["image", "file"]);
export type AttachmentKind = z.infer<typeof AttachmentKindSchema>;
const NameSchema = z.string().min(1).max(MAX_ATTACHMENT_NAME_CHARS)
  .refine(name => !/[\u0000-\u001f\u007f/\\]/u.test(name) && name !== "." && name !== "..", "Invalid attachment name");
const MimeSchema = z.string().max(128).regex(/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/u);
export const AttachmentRefSchema = z.object({
  id: z.string().uuid(), kind: AttachmentKindSchema, name: NameSchema, mime: MimeSchema,
  size: z.number().int().positive().max(MAX_INBOUND_FILE_BYTES), sha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict().refine(ref => ref.kind === "file" ? true : ref.size <= MAX_INBOUND_IMAGE_BYTES &&
  MediaMimeSchema.safeParse(ref.mime).success, "Invalid image attachment");
export type AttachmentRef = z.infer<typeof AttachmentRefSchema>;
export const CommandAttachmentsSchema = z.array(AttachmentRefSchema).min(1).max(MAX_COMMAND_ATTACHMENTS)
  .refine(items => new Set(items.map(item => item.id)).size === items.length, "Duplicate attachment");
export const AttachmentIdsSchema = z.array(z.string().uuid()).min(1).max(MAX_COMMAND_ATTACHMENTS)
  .refine(items => new Set(items).size === items.length, "Duplicate attachment");

export interface StoredInboundAttachment extends AttachmentRef {
  chatId: string; messageId: string; ordinal: number; receivedAt: number; expiresAt: number; data: Buffer;
}
export type AttachmentListing = AttachmentRef & { receivedAt: number };

export interface InboundAttachmentStore {
  /** Idempotent per (chat, message, ordinal); a different payload for the same slot is a conflict. */
  recordInboundAttachment(attachment: StoredInboundAttachment): Promise<AttachmentRef>;
  listInboundAttachments(chatId: string, receivedAfter: number, now: number, limit: number): Promise<AttachmentListing[]>;
  getInboundAttachment(chatId: string, attachmentId: string, now: number): Promise<StoredInboundAttachment | null>;
}

export const attachmentRef = ({ id, kind, name, mime, size, sha256 }: AttachmentRef): AttachmentRef => ({ id, kind, name, mime, size, sha256 });
/** Same slot content regardless of the server-assigned ID. */
export const sameAttachmentContent = (a: AttachmentRef, b: AttachmentRef) =>
  a.kind === b.kind && a.name === b.name && a.mime === b.mime && a.size === b.size && a.sha256 === b.sha256;
export const sameAttachments = (a?: AttachmentRef[], b?: AttachmentRef[]) =>
  JSON.stringify((a ?? []).map(attachmentRef)) === JSON.stringify((b ?? []).map(attachmentRef));

export function validateStoredAttachment(attachment: StoredInboundAttachment): void {
  const parsed = AttachmentRefSchema.safeParse(attachmentRef(attachment));
  if (!parsed.success || !attachment.chatId || attachment.chatId.length > 64 || !attachment.messageId || attachment.messageId.length > 128 ||
      !Number.isSafeInteger(attachment.ordinal) || attachment.ordinal < 0 || attachment.ordinal >= MAX_ATTACHMENTS_PER_MESSAGE ||
      !Buffer.isBuffer(attachment.data) || attachment.data.length !== attachment.size ||
      createHash("sha256").update(attachment.data).digest("hex") !== attachment.sha256 ||
      (attachment.kind === "image" && detectImageMime(attachment.data) !== attachment.mime)) {
    throw new MediaError(400, "attachment_invalid");
  }
}

/** Builds a new record from verified upload bytes; the caller supplies the claimed hash. */
export function newInboundAttachment(input: { chatId: string; messageId: string; ordinal: number; kind: AttachmentKind;
  name: string; mime: string; sha256: string; data: Buffer }, now: number): StoredInboundAttachment {
  const attachment: StoredInboundAttachment = { ...input, id: randomUUID(), size: input.data.length,
    receivedAt: now, expiresAt: now + INBOUND_ATTACHMENT_TTL_MS };
  validateStoredAttachment(attachment);
  return attachment;
}

/**
 * Resolves model-supplied IDs against this chat's recent uploads. Another chat's ID, an expired
 * attachment or one older than the reference window is rejected as unavailable.
 */
export async function resolveAttachmentIds(store: Pick<InboundAttachmentStore, "listInboundAttachments">, chatId: string,
  ids: readonly string[], now: number): Promise<AttachmentRef[]> {
  const parsed = AttachmentIdsSchema.safeParse(ids);
  if (!parsed.success) throw new MediaError(400, "attachment_invalid");
  // Metadata only: the listing never loads attachment bytes.
  const recent = await store.listInboundAttachments(chatId, now - ATTACHMENT_REFERENCE_WINDOW_MS, now, MAX_STORED_ATTACHMENTS);
  return parsed.data.map(id => {
    const attachment = recent.find(item => item.id === id);
    if (!attachment) throw new MediaError(404, "attachment_unavailable");
    return attachmentRef(attachment);
  });
}

export class MemoryInboundAttachments implements InboundAttachmentStore {
  private items = new Map<string, StoredInboundAttachment>();
  constructor(private now: () => number = Date.now) {}

  async recordInboundAttachment(attachment: StoredInboundAttachment): Promise<AttachmentRef> {
    validateStoredAttachment(attachment);
    for (const [id, item] of this.items) if (item.expiresAt <= this.now()) this.items.delete(id);
    const existing = [...this.items.values()].find(item => item.chatId === attachment.chatId &&
      item.messageId === attachment.messageId && item.ordinal === attachment.ordinal);
    if (existing) {
      if (!sameAttachmentContent(existing, attachment)) throw new MediaError(409, "attachment_conflict");
      return attachmentRef(existing);
    }
    const used = [...this.items.values()].reduce((sum, item) => sum + item.size, 0);
    if (this.items.size >= MAX_STORED_ATTACHMENTS || used + attachment.size > MAX_STORED_ATTACHMENT_BYTES) {
      throw new MediaError(429, "attachment_storage_full");
    }
    this.items.set(attachment.id, { ...attachment, data: Buffer.from(attachment.data) });
    return attachmentRef(attachment);
  }

  async listInboundAttachments(chatId: string, receivedAfter: number, now: number, limit: number): Promise<AttachmentListing[]> {
    return [...this.items.values()].filter(item => item.chatId === chatId && item.expiresAt > now && item.receivedAt >= receivedAfter)
      .sort((a, b) => b.receivedAt - a.receivedAt || b.ordinal - a.ordinal).slice(0, limit)
      .map(item => ({ ...attachmentRef(item), receivedAt: item.receivedAt }));
  }

  async getInboundAttachment(chatId: string, attachmentId: string, now: number): Promise<StoredInboundAttachment | null> {
    const item = this.items.get(attachmentId);
    return item && item.chatId === chatId && item.expiresAt > now ? { ...item, data: Buffer.from(item.data) } : null;
  }
}

export interface AttachmentContextEntry { id: string; kind: AttachmentKind; name: string; mime: string; size: number; receivedAt: string }

/** Metadata the leader may cite by ID; bytes and hashes stay server-side. */
export async function recentAttachmentContext(store: Pick<InboundAttachmentStore, "listInboundAttachments">, chatId: string,
  now: number): Promise<AttachmentContextEntry[]> {
  const items = await store.listInboundAttachments(chatId, now - ATTACHMENT_REFERENCE_WINDOW_MS, now, MAX_CONTEXT_ATTACHMENTS);
  return items.map(item => ({ id: item.id, kind: item.kind, name: item.name, mime: item.mime, size: item.size,
    receivedAt: new Date(item.receivedAt).toISOString() }));
}
