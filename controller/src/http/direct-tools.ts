import { Router, type Request, type Response } from "express";
import { ZodError } from "zod";
import { CommandError } from "../commands/service.js";
import { ConflictError } from "../store/interface.js";
import { DirectToolRejectedError, argumentIssues } from "../leader/direct-errors.js";
import { DirectCallSchema, DirectRequestSchema } from "../leader/direct-contracts.js";
import type { DirectToolExecutor } from "../leader/direct-executor.js";
import { createMessageTrace, runWithTrace, traceEvent, traceSpan } from "../runtime/telemetry.js";

/** Wire marker that the business effect never began; Gateways treat only this code as a clean refusal. */
const REJECTED = "DIRECT_TOOL_REJECTED";

/**
 * Every failure body carries `code` and a Chinese `message` for the leader model.
 * Clean refusals keep the `REJECTED` code with `execution: "not_started"` and name the cause in `reason`.
 */
function failure(res: Response, status: number, body: { code: string; message: string; execution: "not_started" | "unknown"; reason?: string }) {
  res.status(status).json(body);
}

/** Mounted behind the Controller's Bearer authentication middleware. */
export function createDirectToolsRouter(direct: Pick<DirectToolExecutor, "list" | "call">,
  isAllowed: (chatId: string) => boolean): Router {
  const router = Router();
  for (const operation of ["list", "call"] as const) {
    router.post(`/tools/${operation}`, async (req: Request, res: Response) => {
      const parsed = operation === "list" ? DirectRequestSchema.safeParse(req.body) : DirectCallSchema.safeParse(req.body);
      if (!parsed.success) {
        failure(res, 400, { code: REJECTED, reason: "INVALID_REQUEST", execution: "not_started",
          message: "工具调用请求的格式不对。不要重试，告诉用户这次请求无法处理。" });
        return;
      }
      const request = parsed.data;
      if (!isAllowed(request.chatId)) {
        failure(res, 403, { code: "CHAT_NOT_ALLOWED", execution: "not_started",
          message: "这个聊天没有使用业务工具的权限。告诉用户这里不能操作，不要重试。" });
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
            failure(res, error.httpStatus, { code: REJECTED, reason: error.code, message: error.message, execution: "not_started" });
            return;
          }
          if (error instanceof ZodError) {
            failure(res, 400, { code: "INVALID_ARGUMENTS", execution: "unknown",
              message: `执行中发现参数不符合要求（${argumentIssues(error)}）。先查询实际状态再告诉用户，不要原样再调一次。` });
            return;
          }
          if (error instanceof CommandError || error instanceof ConflictError) {
            failure(res, error instanceof ConflictError ? 409 : error.httpStatus, { code: "DIRECT_TOOL_FAILED", message: error.message, execution: "unknown" });
            return;
          }
          throw error;
        }
      });
    });
  }
  return router;
}
