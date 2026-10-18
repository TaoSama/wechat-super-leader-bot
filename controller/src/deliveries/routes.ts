import { Router, type Response } from "express";
import { z } from "zod";
import { validateChatId } from "../leader/state.js";
import { isResultId, type ResultDeliveryService } from "./service.js";
import type { DeliveryPlan } from "./contracts.js";

const safePlan = ({ preparation: _preparation, catchupId: _catchup, catchupSourceIds: _sources,
  resumeGeneration: _generation, ...plan }: DeliveryPlan) => plan;
const chatId = z.string().refine(value => { try { validateChatId(value); return true; } catch { return false; } });
const pendingSchema = z.object({ chatIds: z.array(chatId).max(128) }).strict();
const attemptSchema = z.object({ attemptId: z.string().uuid() }).strict();
const receiptSchema = attemptSchema.extend({ status: z.enum(["accepted", "uncertain"]) }).strict();
const deferSchema = attemptSchema.extend({ reason: z.string().min(1).max(128), submittedMessages: z.number().int().min(0).max(4).optional() }).strict();

/** Install behind the existing management / console authentication boundary. */
export function createResultDeliveryRouter(service: ResultDeliveryService, allowed: () => ReadonlySet<string>): Router {
  const router = Router();
  router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  const permitted = async (id: unknown, res: Response) => {
    if (!isResultId(id)) { res.status(400).json({ error: "Invalid result ID" }); return null; }
    const plan = await service.repository.get(id, service.currentTime());
    if (!plan || !allowed().has(plan.chatId)) { res.status(404).json({ error: "Result not found" }); return null; }
    return plan;
  };
  router.get("/", async (_req, res) => {
    res.json({ items: (await service.repository.list([...allowed()])).map(safePlan) });
  });
  router.post("/pending", async (req, res) => {
    const parsed = pendingSchema.safeParse(req.body);
    if (!req.is("application/json") || !parsed.success) { res.status(400).json({ error: "Invalid pending result request" }); return; }
    const chats = parsed.data.chatIds.filter(id => allowed().has(id));
    res.json({ items: (await service.repository.listPending(chats, service.currentTime())).map(safePlan) });
  });
  router.post("/resume", async (req, res) => {
    const parsed = z.object({ chatId, generation: z.string().min(1).max(512).optional() }).strict().safeParse(req.body);
    if (!req.is("application/json") || !parsed.success) { res.status(400).json({ error: "Invalid result resume request" }); return; }
    if (!allowed().has(parsed.data.chatId)) { res.status(404).json({ error: "Result chat not found" }); return; }
    res.json({ resumed: await service.resumeChat(parsed.data.chatId, parsed.data.generation) });
  });
  router.post("/blocked", async (req, res) => {
    const parsed = z.object({ chatId, reason: z.string().min(1).max(128) }).strict().safeParse(req.body);
    if (!req.is("application/json") || !parsed.success) { res.status(400).json({ error: "Invalid blocked result request" }); return; }
    if (!allowed().has(parsed.data.chatId)) { res.status(404).json({ error: "Result chat not found" }); return; }
    res.json({ blocked: await service.repository.markChatWaiting(parsed.data.chatId, parsed.data.reason, service.currentTime()) });
  });
  router.get("/:id", async (req, res) => {
    const plan = await permitted(req.params.id, res);
    if (plan) res.json({ delivery: safePlan(plan) });
  });
  router.get(["/:id/content", "/:id/full"], async (req, res) => {
    const plan = await permitted(req.params.id, res);
    if (!plan) return;
    const artifact = await service.repository.getArtifact(plan.artifact.id);
    if (!artifact) { res.status(404).json({ error: "Result content not found" }); return; }
    if (artifact.expiresAt <= service.currentTime()) { res.status(410).json({ error: "Result artifact expired" }); return; }
    res.type("text/markdown").send(artifact.bytes);
  });
  router.post("/:id/materialize", async (req, res) => {
    const plan = await permitted(req.params.id, res);
    if (!plan) return;
    const parsed = attemptSchema.safeParse(req.body);
    if (!req.is("application/json") || !parsed.success) { res.status(400).json({ error: "Invalid result materialization request" }); return; }
    if (plan.status !== "claimed" || plan.attemptId !== parsed.data.attemptId || (plan.attemptExpiresAt ?? 0) <= service.currentTime()) {
      res.status(409).json({ error: "Result delivery attempt does not match" }); return;
    }
    const delivery = await service.materialize(plan.id);
    if (!delivery) { res.status(409).json({ error: "Result is not ready or its content expired" }); return; }
    res.json({ delivery });
  });
  router.post("/:id/claim", async (req, res) => {
    const plan = await permitted(req.params.id, res);
    if (!plan) return;
    const parsed = attemptSchema.safeParse(req.body);
    if (!req.is("application/json") || !parsed.success) { res.status(400).json({ error: "Invalid result claim request" }); return; }
    const delivery = await service.repository.claim(plan.id, parsed.data.attemptId, service.currentTime());
    if (!delivery) { res.status(409).json({ error: "Result cannot be claimed" }); return; }
    res.json({ delivery: safePlan(delivery) });
  });
  router.post("/:id/receipt", async (req, res) => {
    const plan = await permitted(req.params.id, res);
    if (!plan) return;
    const parsed = receiptSchema.safeParse(req.body);
    if (!req.is("application/json") || !parsed.success) { res.status(400).json({ error: "Invalid result receipt request" }); return; }
    const delivery = await service.repository.recordReceipt(plan.id, parsed.data.status, parsed.data.attemptId);
    if (!delivery) { res.status(409).json({ error: "Result receipt attempt does not match" }); return; }
    res.json({ delivery: safePlan(delivery) });
  });
  router.post("/:id/defer", async (req, res) => {
    const plan = await permitted(req.params.id, res);
    if (!plan) return;
    const parsed = deferSchema.safeParse(req.body);
    if (!req.is("application/json") || !parsed.success) { res.status(400).json({ error: "Invalid result defer request" }); return; }
    const delivery = await service.repository.defer(plan.id, parsed.data.attemptId, parsed.data.reason, service.currentTime(), parsed.data.submittedMessages);
    if (!delivery) { res.status(409).json({ error: "Result defer attempt does not match" }); return; }
    res.json({ delivery: safePlan(delivery) });
  });
  return router;
}

/** A signed URL authorizes only one immutable artifact, for a short fixed duration. */
export function createResultArtifactRouter(service: ResultDeliveryService, allowed: () => ReadonlySet<string>, now = () => service.currentTime()): Router {
  const router = Router();
  router.get("/:id/download", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const id = req.params.id;
    if (!isResultId(id) || !service.validDownload(id, req.query.expires, req.query.signature)) {
      res.status(403).json({ error: "Invalid or expired result download authorization" }); return;
    }
    const artifact = await service.repository.getArtifact(id);
    if (!artifact || !allowed().has(artifact.chatId)) { res.status(404).json({ error: "Result artifact not found" }); return; }
    if (artifact.expiresAt <= now()) { res.status(410).json({ error: "Result artifact expired" }); return; }
    res.setHeader("Content-Disposition", `attachment; filename="${artifact.name}"`);
    res.setHeader("Content-Length", artifact.size);
    res.type("text/markdown").send(artifact.bytes);
  });
  return router;
}
