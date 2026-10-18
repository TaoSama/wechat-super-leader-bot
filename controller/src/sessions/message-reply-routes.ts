import { Router } from "express";
import type { IStore } from "../store/interface.js";
import { PostMessageRequestSchema } from "../types.js";

const ReplyQuerySchema = PostMessageRequestSchema.pick({ chatId: true }).strict();
const ReplyParamsSchema = PostMessageRequestSchema.pick({ messageId: true }).strict();

/** Mount below the management-authenticated /v1 router. */
export function createMessageReplyRouter(
  store: Pick<IStore, "getMessage">,
  allowedChatIds: () => ReadonlySet<string>,
): Router {
  const router = Router();
  router.get("/messages/:messageId/reply", async (req, res) => {
    const query = ReplyQuerySchema.safeParse(req.query);
    const params = ReplyParamsSchema.safeParse(req.params);
    if (!query.success || !params.success) {
      res.status(400).json({ error: "Invalid message reply request" });
      return;
    }
    const { chatId } = query.data;
    if (!allowedChatIds().has(chatId)) {
      res.status(403).json({ code: "CHAT_NOT_ALLOWED" });
      return;
    }
    const message = await store.getMessage(chatId, params.data.messageId);
    if (!message) {
      res.status(404).json({ error: "Message reply not found" });
      return;
    }
    res.json({
      text: message.replyText,
      ...(message.commandId !== undefined ? { commandId: message.commandId } : {}),
      ...(message.images ? { images: message.images } : {}),
    });
  });
  return router;
}
