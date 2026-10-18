import { createHash } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { CommandService } from "../commands/service.js";
import { publicCommand } from "../commands/public.js";
import { NodeHub } from "../nodes/hub.js";
import { HistoryError } from "../sessions/history.js";
import { TERMINAL_SESSION_ID_PATTERN } from "../sessions/terminal.js";
import { DeliveryModeSchema, TurnIdSchema, type CommandAuthority } from "../types.js";

const TargetSchema = z.object({
  nodeId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  sessionId: z.string().min(1).max(64).refine(value => /^[A-Za-z0-9_-]+$/.test(value) || TERMINAL_SESSION_ID_PATTERN.test(value)),
});
const HistoryQuerySchema = z.object({
  source: z.literal("control-socket").optional(),
  cursor: z.string().min(1).max(4096).optional(),
  historyContext: z.string().uuid().optional(),
  limit: z.string().regex(/^(?:[1-9]|[1-4][0-9]|50)$/).transform(Number).optional(),
}).strict().refine(value => !value.cursor || !!value.historyContext, "History cursor requires context");
const MessageSchema = z.object({
  prompt: z.string().min(1).max(16000).refine(value => value.trim().length > 0),
  requestId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  deliveryMode: DeliveryModeSchema.optional(),expectedTurnId:TurnIdSchema.optional(),
}).strict();
const CancelSchema = z.object({cancelCommandId:z.string().min(1).max(64)}).strict();
const RequestIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
function webRequestId(requestId: string): string {
  return "web_" + createHash("sha256").update(JSON.stringify(["session-message", requestId])).digest("hex");
}

export function createSessionRouter(hub: NodeHub, commands: CommandService): Router {
  const router = Router();
  router.get("/:nodeId/:sessionId/messages/:requestId", async (req, res) => {
    const target = TargetSchema.safeParse(req.params), requestId = RequestIdSchema.safeParse(req.params.requestId);
    if (!target.success || !requestId.success) { res.status(400).json({error:"Invalid command recovery request"}); return; }
    const authority = res.locals.commandAuthority as CommandAuthority | undefined;
    if (!authority) { res.status(403).json({error:"Command recovery authority is unavailable"}); return; }
    const command = await commands.getByRequestId(webRequestId(requestId.data),authority);
    if (!command || command.nodeId !== target.data.nodeId || command.sessionId !== target.data.sessionId) {
      res.status(404).json({error:"Command not found for this authorization and target"}); return;
    }
    res.json(publicCommand(command));
  });
  router.get("/:nodeId/:sessionId/history", async (req, res) => {
    const target = TargetSchema.safeParse(req.params);
    const query = HistoryQuerySchema.safeParse(req.query);
    if (!target.success || !query.success) {
      res.status(400).json({ error: "Invalid session history request" });
      return;
    }
    const abort = new AbortController();
    const onClose = () => abort.abort();
    res.once("close", onClose);
    try {
      const history = await hub.readHistory(target.data.nodeId, target.data.sessionId, query.data, abort.signal);
      if (!abort.signal.aborted) res.json(history);
    } catch (error) {
      if (abort.signal.aborted) return;
      if (error instanceof HistoryError) {
        res.status(error.httpStatus).json({ code: error.code, error: error.message });
        return;
      }
      throw error;
    } finally {
      res.off("close", onClose);
    }
  });

  router.post("/:nodeId/:sessionId/messages", async (req, res) => {
    const target = TargetSchema.safeParse(req.params);
    const cancellation = CancelSchema.safeParse(req.body);
    if (target.success && cancellation.success && req.is("application/json")) {
      const authority = res.locals.commandAuthority as CommandAuthority | undefined;
      const original = await commands.get(cancellation.data.cancelCommandId);
      if (!original || original.nodeId !== target.data.nodeId || original.sessionId !== target.data.sessionId) {res.status(404).json({error:"Command target mismatch"});return;}
      res.json(publicCommand(await commands.cancel(cancellation.data.cancelCommandId,authority))); return;
    }
    const body = MessageSchema.safeParse(req.body);
    if (!req.is("application/json") || !target.success || !body.success) {
      res.status(400).json({ error: "Invalid session message request" });
      return;
    }
    const requestId = webRequestId(body.data.requestId);
    const assertDispatchAllowed = res.locals.assertConsoleDispatch as (() => Promise<void>) | undefined;
    const command = await commands.submit({
      ...target.data, action: "send", prompt: body.data.prompt, requestId,deliveryMode:body.data.deliveryMode,expectedTurnId:body.data.expectedTurnId,
    }, 0, assertDispatchAllowed,undefined,res.locals.commandAuthority);
    res.status(["queued","pending"].includes(command.status) ? 202 : 200).json(publicCommand(command));
  });
  return router;
}
