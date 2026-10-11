import { createHash } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { CommandService } from "../commands.js";
import { NodeHub } from "../hub.js";
import { HistoryError } from "../session-history.js";
import { TERMINAL_SESSION_ID_PATTERN } from "../terminal-session.js";

const TargetSchema = z.object({
  nodeId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  sessionId: z.string().min(1).max(64).refine(value => /^[A-Za-z0-9_-]+$/.test(value) || TERMINAL_SESSION_ID_PATTERN.test(value)),
});
const HistoryQuerySchema = z.object({
  cursor: z.string().min(1).max(4096).optional(),
  historyContext: z.string().uuid().optional(),
  limit: z.string().regex(/^(?:[1-9]|[1-4][0-9]|50)$/).transform(Number).optional(),
}).strict().refine(value => !value.cursor || !!value.historyContext, "History cursor requires context");
const MessageSchema = z.object({
  prompt: z.string().min(1).max(16000).refine(value => value.trim().length > 0),
  requestId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
}).strict();

export function createSessionRouter(hub: NodeHub, commands: CommandService): Router {
  const router = Router();
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
    const body = MessageSchema.safeParse(req.body);
    if (!req.is("application/json") || !target.success || !body.success) {
      res.status(400).json({ error: "Invalid session message request" });
      return;
    }
    const requestId = "web_" + createHash("sha256")
      .update(JSON.stringify(["session-message", body.data.requestId])).digest("hex");
    const assertDispatchAllowed = res.locals.assertConsoleDispatch as (() => Promise<void>) | undefined;
    const command = await commands.submit({
      ...target.data, action: "send", prompt: body.data.prompt, requestId,
    }, 0, assertDispatchAllowed);
    res.status(command.status === "pending" ? 202 : 200).json(command);
  });
  return router;
}
