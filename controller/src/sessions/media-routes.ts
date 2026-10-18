import { Router } from "express";
import { z } from "zod";
import type { MessageImageStore } from "./message-images.js";
import { ReplyImagesSchema } from "./media-contracts.js";
import type { MessageRecord } from "../types.js";

interface ImageRouteStore extends MessageImageStore {
  getLeaderState(chatId: string): Promise<{ data: Record<string, unknown> } | null>;
  getMessage(chatId: string, messageId: string): Promise<MessageRecord | null>;
}
const QuerySchema = z.object({ chatId: z.string().min(1).max(64) }).strict();
const ReceiptSchema = z.object({ messageId: z.string(), images: ReplyImagesSchema.optional() });

/** Mount below authenticated /v1; a browser console cookie does not authorize this route. */
export function createMediaRouter(store: ImageRouteStore, allowedChatIds: () => ReadonlySet<string>, now = Date.now): Router {
  const router = Router();
  router.get("/messages/:messageId/images/:imageId", async (req, res) => {
    const query = QuerySchema.safeParse(req.query);
    const imageId = z.string().uuid().safeParse(req.params.imageId);
    const messageId = z.string().min(1).max(128).safeParse(req.params.messageId);
    if (!query.success || !imageId.success || !messageId.success) { res.status(400).json({ error: "Invalid image request" }); return; }
    const { chatId } = query.data;
    if (!allowedChatIds().has(chatId)) { res.status(403).json({ code: "CHAT_NOT_ALLOWED" }); return; }
    const message = await store.getMessage(chatId, messageId.data);
    const state = message ? null : await store.getLeaderState(chatId);
    const receipts = z.array(ReceiptSchema).safeParse(state?.data.receipts ?? []);
    const receipt = receipts.success ? receipts.data.find(item => item.messageId === messageId.data) : undefined;
    const expected = (message?.images ?? receipt?.images)?.find(item => item.id === imageId.data);
    if (!expected) { res.status(404).json({ error: "Image not found" }); return; }
    const image = await store.getMessageImage(chatId, messageId.data, imageId.data, now());
    if (!image) { res.status(410).json({ error: "Image expired" }); return; }
    if (image.sha256 !== expected.sha256 || image.size !== expected.size || image.mime !== expected.mime || image.data.length !== expected.size) {
      res.status(502).json({ error: "Image integrity check failed" }); return;
    }
    res.setHeader("Content-Type", image.mime);
    res.setHeader("Content-Length", String(image.size));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.send(image.data);
  });
  return router;
}
