import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { IStore } from "../store/interface.js";
import { NotificationIdSchema, NotificationReceiptStatusSchema, NotificationDeferReasonSchema } from "./contracts.js";
import { validateChatId } from "../leader/state.js";

const MAX_REQUESTED_CHATS = 128;
const chatId = z.string().refine(value => { try { validateChatId(value); return true; } catch { return false; } });
const PendingSchema = z.object({ chatIds: z.array(chatId).max(MAX_REQUESTED_CHATS) }).strict();
const ClaimSchema = z.object({ attemptId: NotificationIdSchema }).strict();
const ReceiptSchema = ClaimSchema.extend({ status: NotificationReceiptStatusSchema }).strict();
const DeferSchema = ClaimSchema.extend({ reason: NotificationDeferReasonSchema }).strict();

export function createNotificationRouter(store: IStore, allowed: () => ReadonlySet<string>, now: () => number): Router {
  const router = Router();
  router.use((req, res, next) => {
    if (req.originalUrl.includes("?")) { res.status(400).json({ error: "Notification interfaces do not accept query parameters" }); return; }
    next();
  });
  router.post("/pending", async (req, res) => {
    const parsed = PendingSchema.safeParse(req.body);
    if (!req.is("application/json") || !parsed.success) { res.status(400).json({ error: "Invalid pending notification request" }); return; }
    const permitted = allowed();
    const chatIds = parsed.data.chatIds.filter(id => permitted.has(id));
    res.json({ items: await store.listPendingNotifications(chatIds, now()) });
  });
  const parseId = (req: Request, res: Response) => {
    const result = NotificationIdSchema.safeParse(req.params.id);
    if (!result.success) { res.status(400).json({ error: "Invalid notification ID" }); return null; }
    return result.data;
  };
  const respond = (res: Response, notification: Awaited<ReturnType<IStore["getNotification"]>>) => {
    if (!notification) res.status(404).json({ error: "Notification not found" });
    else res.json({ notification });
  };
  router.get("/:id", async (req, res) => {
    const id = parseId(req, res);
    if (id) respond(res, await store.getNotification(id, now()));
  });
  router.post("/:id/claim", async (req, res) => {
    const id = parseId(req, res);
    if (!id) return;
    const parsed = ClaimSchema.safeParse(req.body);
    if (!req.is("application/json") || !parsed.success) { res.status(400).json({ error: "Invalid notification claim request" }); return; }
    respond(res, await store.claimNotification(id, parsed.data.attemptId, [...allowed()], now()));
  });
  router.post("/:id/receipt", async (req, res) => {
    const id = parseId(req, res);
    if (!id) return;
    const parsed = ReceiptSchema.safeParse(req.body);
    if (!req.is("application/json") || !parsed.success) { res.status(400).json({ error: "Invalid notification receipt request" }); return; }
    respond(res, await store.recordNotificationReceipt(id, parsed.data.attemptId, parsed.data.status, now()));
  });
  router.post("/:id/defer", async (req, res) => {
    const id = parseId(req, res);
    if (!id) return;
    const parsed = DeferSchema.safeParse(req.body);
    if (!req.is("application/json") || !parsed.success) { res.status(400).json({ error: "Invalid notification defer request" }); return; }
    respond(res, await store.deferNotification(id, parsed.data.attemptId, parsed.data.reason, now()));
  });
  return router;
}
