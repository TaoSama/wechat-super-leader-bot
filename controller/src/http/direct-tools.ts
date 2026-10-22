import { Router, type Request, type Response } from "express";
import { ZodError } from "zod";
import { DirectToolRejectedError } from "../leader/direct-errors.js";
import { DirectCallSchema, DirectRequestSchema } from "../leader/direct-contracts.js";
import type { DirectToolExecutor } from "../leader/direct-executor.js";
import { createMessageTrace, runWithTrace, traceEvent, traceSpan } from "../runtime/telemetry.js";

/** Mounted behind the Controller's Bearer authentication middleware. */
export function createDirectToolsRouter(direct: Pick<DirectToolExecutor, "list" | "call">,
  isAllowed: (chatId: string) => boolean): Router {
  const router = Router();
  for (const operation of ["list", "call"] as const) {
    router.post(`/tools/${operation}`, async (req: Request, res: Response) => {
      const parsed = operation === "list" ? DirectRequestSchema.safeParse(req.body) : DirectCallSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ code: "DIRECT_TOOL_REJECTED", execution: "not_started", error: "Invalid direct tool request body", details: parsed.error.format() });
        return;
      }
      const request = parsed.data;
      if (!isAllowed(request.chatId)) {
        res.status(403).json({ code: "CHAT_NOT_ALLOWED", execution: "not_started", error: "Chat is not authorized in ALLOWED_CHAT_IDS" });
        return;
      }
      const trace = createMessageTrace(request.chatId, request.messageId, undefined,
        req.headers["x-latency-attempt"] as string | undefined);
      await runWithTrace(trace, async () => {
        traceEvent("controller.received", { inputChars: request.text.length });
        let finished = false;
        res.once("finish", () => runWithTrace(trace, () => {
          finished = true;
          traceEvent("controller.response.finish", { httpStatus: res.statusCode,
            outcome: res.statusCode < 400 ? "ok" : "error" });
        }));
        res.once("close", () => {
          if (!finished) runWithTrace(trace, () => traceEvent("controller.response.close", {
            httpStatus: res.statusCode, outcome: "disconnected",
          }));
        });
        try {
          const result = await traceSpan(`controller.tools.${operation}`, async () => operation === "list"
            ? direct.list(request) : direct.call(DirectCallSchema.parse(request)));
          res.json(result);
        } catch (error) {
          if (error instanceof DirectToolRejectedError) {
            res.status(error.httpStatus).json({ code: "DIRECT_TOOL_REJECTED", execution: "not_started", error: error.message });
            return;
          }
          if (!(error instanceof ZodError)) throw error;
          res.status(400).json({ error: "Invalid business tool arguments", details: error.format() });
        }
      });
    });
  }
  return router;
}
