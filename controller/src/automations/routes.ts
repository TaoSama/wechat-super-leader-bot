import { Router, type ErrorRequestHandler, type Request, type Response } from "express";
import { z } from "zod";
import { CreateScheduleSchema } from "./contracts.js";
import type { AutomationService, CreationAuthority } from "./service.js";
import { AutomationConflictError, AutomationValidationError } from "./errors.js";

const chatSchema = z.string().trim().min(1).max(64);
const QuerySchema = z.object({ chatId: chatSchema }).strict();
const CreateSchema = z.object({ chatId: chatSchema, input: CreateScheduleSchema }).strict();
const UpdateSchema = z.object({ chatId: chatSchema, status: z.enum(["active", "paused", "cancelled"]) }).strict();
const IdSchema = z.string().uuid();
const IdempotencyKeySchema = z.string().min(1).max(256).regex(/^[\x21-\x7e]+$/);
export interface AutomationRouterOptions {
  allowed: () => ReadonlySet<string>;
  /** Must validate trusted current user intent; request/model-supplied booleans are not authority. */
  authority: (req: Request, chatId: string) => Promise<CreationAuthority | null>;
  now?: () => number;
}
export function createAutomationRouter(service: AutomationService, options: AutomationRouterOptions): Router {
  const router = Router();
  const allowed = (chatId: string, res: Response): boolean => {
    if (options.allowed().has(chatId)) return true;
    res.status(403).json({ error: "Chat is not permitted" });
    return false;
  };
  const authority = async (req: Request, res: Response, chatId: string): Promise<CreationAuthority | null> => {
    const result = await options.authority(req, chatId);
    if (result?.chatId === chatId && result.explicitCurrentTurnAuthorization && result.currentMessageId.trim()) return result;
    res.status(403).json({ error: "Explicit current user authorization is required" });
    return null;
  };
  router.get("/", async (req, res) => {
    const query = QuerySchema.safeParse(req.query);
    if (!query.success) { res.status(400).json({ error: "Invalid schedule query" }); return; }
    if (allowed(query.data.chatId, res)) res.json({ items: await service.repository.list(query.data.chatId) });
  });
  router.post("/", async (req, res) => {
    const body = CreateSchema.safeParse(req.body);
    if (!req.is("application/json") || !body.success) { res.status(400).json({ error: "Invalid schedule request" }); return; }
    if (!allowed(body.data.chatId, res)) return;
    const key = IdempotencyKeySchema.safeParse(req.headers["idempotency-key"]);
    if (!key.success) { res.status(400).json({ error: "A stable Idempotency-Key of 1–256 visible ASCII characters is required" }); return; }
    const consent = await authority(req, res, body.data.chatId);
    if (consent) res.status(201).json({ schedule: await service.create(body.data.input, { ...consent, idempotencyKey: key.data }) });
  });
  router.get("/:id", async (req, res) => {
    const query = QuerySchema.safeParse(req.query), id = IdSchema.safeParse(req.params.id);
    if (!query.success || !id.success) { res.status(400).json({ error: "Invalid schedule query" }); return; }
    if (!allowed(query.data.chatId, res)) return;
    const schedule = await service.repository.get(id.data, query.data.chatId);
    if (schedule) res.json({ schedule }); else res.status(404).json({ error: "Schedule not found" });
  });
  router.get("/:id/runs", async (req, res) => {
    const query = QuerySchema.safeParse(req.query), id = IdSchema.safeParse(req.params.id);
    if (!query.success || !id.success) { res.status(400).json({ error: "Invalid schedule query" }); return; }
    if (!allowed(query.data.chatId, res)) return;
    if (!await service.repository.get(id.data, query.data.chatId)) { res.status(404).json({ error: "Schedule not found" }); return; }
    res.json({ items: await service.repository.listRuns(id.data, query.data.chatId) });
  });
  router.post("/:id/status", async (req, res) => {
    const body = UpdateSchema.safeParse(req.body), id = IdSchema.safeParse(req.params.id);
    if (!req.is("application/json") || !body.success || !id.success) { res.status(400).json({ error: "Invalid schedule status request" }); return; }
    if (!allowed(body.data.chatId, res) || !await authority(req, res, body.data.chatId)) return;
    const schedule = await service.repository.setStatus(id.data, body.data.chatId, body.data.status, (options.now ?? Date.now)());
    if (schedule) res.json({ schedule }); else res.status(404).json({ error: "Schedule not found" });
  });
  const clientErrors: ErrorRequestHandler = (error: unknown, _req, res, next) => {
    if (error instanceof AutomationValidationError || error instanceof AutomationConflictError) {
      res.status(error instanceof AutomationValidationError ? 400 : 409).json({ error: error.message });
    } else next(error);
  };
  router.use(clientErrors);
  return router;
}
