import { Router, type Response } from "express";
import { z } from "zod";
import type { NodeHub } from "../nodes/hub.js";
import { AutomationError, AutomationInspectOptionsSchema } from "../sessions/automation-contracts.js";
import type { BackgroundService } from "./service.js";
import { publicBackgroundDetails, publicBackgroundWorker } from "./public.js";

const ChatId = z.string().trim().min(1).max(64);
const Query = z.object({ chatId: ChatId }).strict();
const Id = z.string().uuid();
const Followup = z.object({ chatId: ChatId, prompt: z.string().trim().min(1).max(128_000),
  requestId: z.string().trim().min(1).max(256) }).strict();
const Extend = z.object({ chatId: ChatId, expiresAt: z.string().datetime({ offset: true }) }).strict();
const NodeId = z.string().trim().min(1).max(128);
const SourceQuery = z.object({ nodeId: NodeId }).strict();
const InspectionQuery = SourceQuery.extend({ expectedAt: z.string().regex(/^\d{1,16}$/), notAfter: z.string().regex(/^\d{1,16}$/) });
type BackgroundHttpService = Pick<BackgroundService, "repository" | "list" | "enqueue" | "extend">;
type SourceHub = Pick<NodeHub, "getNodeStatusList" | "listAutomations" | "inspectAutomation">;

/** Mount only behind administrator authentication; browser cookies do not authorize these mutations. */
export function createBackgroundRouter(service: BackgroundHttpService | undefined,
  allowed: () => ReadonlySet<string>): Router {
  const router = Router();
  router.use((_req, res, next) => {
    if (!service) { res.status(503).json({ error: "Background execution is not configured" }); return; }
    next();
  });
  function permit(chatId: string, res: Response): boolean {
    if (allowed().has(chatId)) return true;
    res.status(403).json({ error: "Chat is not permitted" }); return false;
  }
  router.get("/", async (req, res) => {
    const query = Query.safeParse(req.query);
    if (!query.success) { res.status(400).json({ error: "Invalid background query" }); return; }
    if (!permit(query.data.chatId, res)) return;
    const tasks = (await service!.list(query.data.chatId)).filter(worker => worker.chatId === query.data.chatId);
    res.json({ tasks: tasks.map(publicBackgroundWorker) });
  });
  router.get("/:runId", async (req, res) => {
    const query = Query.safeParse(req.query), id = Id.safeParse(req.params.runId);
    if (!query.success || !id.success) { res.status(400).json({ error: "Invalid background query" }); return; }
    if (!permit(query.data.chatId, res)) return;
    const worker = await service!.repository.getByRun(id.data);
    if (!worker || worker.chatId !== query.data.chatId) { res.status(404).json({ error: "Background task not found" }); return; }
    res.json({ task: publicBackgroundDetails(worker) });
  });
  router.post("/:runId/follow-up", async (req, res) => {
    const body = Followup.safeParse(req.body), id = Id.safeParse(req.params.runId);
    if (!req.is("application/json") || !body.success || !id.success) { res.status(400).json({ error: "Invalid background follow-up" }); return; }
    if (!permit(body.data.chatId, res)) return;
    const worker = await service!.repository.getByRun(id.data);
    if (!worker || worker.chatId !== body.data.chatId) { res.status(404).json({ error: "Background task not found" }); return; }
    try {
      res.status(202).json({ task: publicBackgroundWorker(await service!.enqueue(worker.id, body.data.chatId, body.data.prompt, body.data.requestId)) });
    } catch { res.status(409).json({ error: "Background follow-up could not be queued; inspect the task before retrying" }); }
  });
  router.post("/:runId/extend", async (req, res) => {
    const body = Extend.safeParse(req.body), id = Id.safeParse(req.params.runId);
    if (!req.is("application/json") || !body.success || !id.success) { res.status(400).json({ error: "Invalid background extension" }); return; }
    if (!permit(body.data.chatId, res)) return;
    const worker = await service!.repository.getByRun(id.data);
    if (!worker || worker.chatId !== body.data.chatId) { res.status(404).json({ error: "Background task not found" }); return; }
    try { res.json({ task: publicBackgroundWorker(await service!.extend(worker.id, body.data.chatId, Date.parse(body.data.expiresAt))) }); }
    catch { res.status(409).json({ error: "Background task cannot be extended to the requested expiry" }); }
  });
  return router;
}

export function createSourceAutomationRouter(hub: SourceHub): Router {
  const router = Router();
  function known(nodeId: string, res: Response): boolean {
    if (hub.getNodeStatusList().some(node => node.nodeId === nodeId)) return true;
    res.status(404).json({ error: "Source node not found" }); return false;
  }
  router.get("/", async (req, res) => {
    const query = SourceQuery.safeParse(req.query);
    if (!query.success) { res.status(400).json({ error: "Invalid source automation query" }); return; }
    if (!known(query.data.nodeId, res)) return;
    res.json({ items: (await hub.listAutomations(query.data.nodeId)).map(({ prompt: _prompt, ...item }) => ({ ...item, nodeId: query.data.nodeId })) });
  });
  router.get("/:automationId", async (req, res) => {
    const query = InspectionQuery.safeParse(req.query);
    if (!query.success) { res.status(400).json({ error: "Invalid source occurrence query" }); return; }
    const options = AutomationInspectOptionsSchema.safeParse({ automationId: req.params.automationId,
      expectedAt: Number(query.data.expectedAt), notAfter: Number(query.data.notAfter) });
    if (!options.success) { res.status(400).json({ error: "Invalid source occurrence window" }); return; }
    if (!known(query.data.nodeId, res)) return;
    const items = await hub.listAutomations(query.data.nodeId);
    if (!items.some(item => item.id === options.data.automationId)) { res.status(404).json({ error: "Source automation not found" }); return; }
    res.json({ observation: await hub.inspectAutomation(query.data.nodeId, options.data) });
  });
  router.use((error: unknown, _req: unknown, res: Response, _next: unknown) => {
    const status = error instanceof AutomationError ? error.status : 503;
    res.status(status).json({ error: "Source automation observation is unavailable" });
  });
  return router;
}
