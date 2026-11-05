import express, { Router, type Request, type Response } from "express";
import { z } from "zod";
import { MediaError } from "./media-contracts.js";
import {
  AttachmentKindSchema, MAX_ATTACHMENTS_PER_MESSAGE, MAX_INBOUND_FILE_BYTES, MAX_INBOUND_IMAGE_BYTES, newInboundAttachment,
  type InboundAttachmentStore,
} from "./inbound-attachments.js";
import type { CommandRecord } from "../types.js";

const UploadQuerySchema = z.object({
  chatId: z.string().min(1).max(64), messageId: z.string().min(1).max(128),
  ordinal: z.coerce.number().int().min(0).max(MAX_ATTACHMENTS_PER_MESSAGE - 1), kind: AttachmentKindSchema,
  name: z.string().min(1).max(255), mime: z.string().min(1).max(128), sha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

function mediaFailure(res: Response, error: unknown): void {
  if (!(error instanceof MediaError)) throw error;
  res.status(error.httpStatus).json({ code: error.code });
}

/** Mount below authenticated /v1. The Gateway stores one verified inbound attachment per call. */
export function createAttachmentUploadRouter(store: InboundAttachmentStore, allowedChatIds: () => ReadonlySet<string>,
  now = Date.now): Router {
  const router = Router();
  router.post("/inbound-attachments", express.raw({ type: "application/octet-stream", limit: MAX_INBOUND_FILE_BYTES }),
    async (req: Request, res: Response) => {
      const query = UploadQuerySchema.safeParse(req.query);
      if (!query.success || !Buffer.isBuffer(req.body) || req.body.length === 0) {
        res.status(400).json({ code: "attachment_invalid" }); return;
      }
      const { chatId, kind, ...rest } = query.data;
      if (!allowedChatIds().has(chatId)) { res.status(403).json({ code: "CHAT_NOT_ALLOWED" }); return; }
      if (kind === "image" && req.body.length > MAX_INBOUND_IMAGE_BYTES) { res.status(413).json({ code: "attachment_too_large" }); return; }
      try {
        const attachment = await store.recordInboundAttachment(newInboundAttachment({ chatId, kind, ...rest, data: req.body }, now()));
        res.json({ attachment });
      } catch (error) { mediaFailure(res, error); }
    });
  return router;
}

interface DaemonAttachmentStore extends InboundAttachmentStore {
  getCommand(commandId: string): Promise<CommandRecord | null>;
}

/**
 * Mount outside the Gateway-authenticated router. A node may read bytes only for an attachment
 * frozen on its own in-flight command, and only from the chat that authorized that command.
 */
export function createDaemonAttachmentRouter(store: DaemonAttachmentStore, authenticateNode: (token: string) => string | null,
  allowedChatIds: () => ReadonlySet<string>, now = Date.now): Router {
  const router = Router();
  router.get("/:commandId/:attachmentId", async (req: Request, res: Response) => {
    const header = req.headers.authorization ?? "";
    const nodeId = header.startsWith("Bearer ") ? authenticateNode(header.slice("Bearer ".length).trim()) : null;
    if (!nodeId) { res.status(401).json({ code: "UNAUTHORIZED" }); return; }
    const attachmentId = z.string().uuid().safeParse(req.params.attachmentId);
    const commandId = z.string().min(1).max(64).safeParse(req.params.commandId);
    if (!attachmentId.success || !commandId.success) { res.status(400).json({ code: "attachment_invalid" }); return; }
    const command = await store.getCommand(commandId.data);
    const authority = command?.authority;
    const chatId = authority && (authority.type === "chat" || authority.type === "plan") ? authority.chatId : undefined;
    const expected = command?.attachments?.find(item => item.id === attachmentId.data);
    if (!command || command.nodeId !== nodeId || command.action !== "send" || command.status !== "pending" ||
        Date.parse(command.expiresAt) <= now() || !chatId || !expected) {
      res.status(404).json({ code: "attachment_unavailable" }); return;
    }
    if (!allowedChatIds().has(chatId)) { res.status(403).json({ code: "CHAT_NOT_ALLOWED" }); return; }
    const attachment = await store.getInboundAttachment(chatId, expected.id, now());
    if (!attachment) { res.status(410).json({ code: "attachment_expired" }); return; }
    if (attachment.sha256 !== expected.sha256 || attachment.size !== expected.size || attachment.data.length !== expected.size) {
      res.status(502).json({ code: "attachment_integrity" }); return;
    }
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", String(attachment.size));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.send(attachment.data);
  });
  return router;
}
