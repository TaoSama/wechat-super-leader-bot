import { Router, type Response } from "express";
import { z } from "zod";
import { ActionSchema, MAX_GOAL_TARGETS, MAX_PLAN_ACTIONS } from "../leader/contracts.js";
import { GoalProposalSchema, GoalTargetSchema } from "../leader/goals/goal.js";
import type { ConsoleAuthorizationRequest, ConsoleAuthorizationResult, ConsoleAuthorizations } from "../leader/console-authorization.js";

const RequestIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const IdSchema = z.string().uuid();
// Shape only, derived from the leader schemas; skills, routes and delivery modes stay server-owned.
// Dependency, eligibility, cap and exclusion rules run in the leader's proposal path.
const PlanBodySchema = z.object({ requestId: RequestIdSchema,
  steps: z.array(ActionSchema.pick({ nodeId: true, sessionId: true, prompt: true, dependsOn: true, resultFrom: true }).strict()).min(1).max(MAX_PLAN_ACTIONS) }).strict();
const GoalBodySchema = GoalProposalSchema.pick({ objective: true, criteria: true, constraints: true, maxActions: true, maxDecisions: true, durationMinutes: true })
  .extend({ requestId: RequestIdSchema, targets: z.array(GoalTargetSchema.pick({ nodeId: true, sessionId: true }).strict()).min(1).max(MAX_GOAL_TARGETS) }).strict();
const CancelBodySchema = z.object({ requestId: RequestIdSchema }).strict();

const STATUS: Record<ConsoleAuthorizationResult["outcome"], number> = { created: 201, cancelled: 200, rejected: 422, missing: 404 };

/** Console plan/goal writes; the auth middleware already proved cookie, origin and intent. */
export function createAuthorizationRouter(authorizations: Pick<ConsoleAuthorizations, "authorize">): Router {
  const router = Router();
  const submit = async (res: Response, requestId: string, request: ConsoleAuthorizationRequest) => {
    const chatId = res.locals.consoleChatId as string | undefined;
    if (!chatId) {
      res.status(403).json({ code: "console_chat_unbound", error: "此登录未绑定微信聊天，请在微信中重新获取控制台链接" });
      return;
    }
    await (res.locals.assertConsoleDispatch as (() => Promise<void>) | undefined)?.();
    const result = await authorizations.authorize(chatId, requestId, request);
    res.status(result.replayed ? 200 : STATUS[result.outcome]).json({ outcome: result.outcome, ...(result.id ? { id: result.id } : {}),
      message: result.text, replayed: result.replayed });
  };
  // Each route validates its body (and plan/goal id) before any chat state is touched.
  const route = <T extends z.ZodType<{ requestId: string }>>(path: string, schema: T, error: string,
    toRequest: (body: z.infer<T>, id: string) => ConsoleAuthorizationRequest) => {
    router.post(path, async (req, res) => {
      const body = schema.safeParse(req.body), id = req.params.id === undefined ? undefined : IdSchema.safeParse(req.params.id);
      if (!req.is("application/json") || !body.success || id && !id.success) { res.status(400).json({ error }); return; }
      await submit(res, body.data.requestId, toRequest(body.data, id?.data?.toLowerCase() ?? ""));
    });
  };
  route("/plans", PlanBodySchema, "Invalid plan request", body => ({ kind: "create_plan", steps: body.steps }));
  route("/goals", GoalBodySchema, "Invalid goal request", ({ requestId: _requestId, ...goal }) => ({ kind: "create_goal", goal: { ...goal, shareResults: true } }));
  route("/plans/:id/cancel", CancelBodySchema, "Invalid plan cancellation", (_body, planId) => ({ kind: "cancel_plan", planId }));
  route("/goals/:id/cancel", CancelBodySchema, "Invalid goal cancellation", (_body, goalId) => ({ kind: "cancel_goal", goalId }));
  return router;
}
