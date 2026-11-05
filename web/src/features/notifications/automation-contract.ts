import type { SendRoute } from "../../types";
import { isAgentKind, targetAgentKind, type AgentKind } from "../sessions/agent-kind";

export type AutomationStatus = "active" | "paused" | "cancelled" | "completed";
export interface ConsoleAutomation {
  id: string;
  chatId: string;
  title: string;
  kind: "reminder" | "session" | "background";
  timing: { type: "at"; at: string } | { type: "cron"; expression: string };
  timezone: string;
  status: AutomationStatus;
  nextAt: number | null;
  activeRunId?: string;
  lastOutcome?: "completed" | "failed";
  /** Background schedules: the executor that runs their next turns. */
  executor?: AgentKind;
  /** Session schedules: the session frozen at creation. */
  target?: { nodeId: string; sessionId: string; sendRoute: SendRoute };
}

const STATUSES = new Set(["active", "paused", "cancelled", "completed"]);
const MAX_DATE_MS = 8_640_000_000_000_000;

export function parseAutomation(raw: unknown): ConsoleAutomation {
  const fail = (): never => { throw new Error("定时任务状态格式无效"); };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail();
  const item = raw as Record<string, unknown>;
  if (typeof item.id !== "string" || !item.id.trim() || typeof item.chatId !== "string" || !item.chatId.trim() ||
      typeof item.title !== "string" || !item.title.trim() || !STATUSES.has(String(item.status)) ||
      (item.kind !== "reminder" && item.kind !== "session" && item.kind !== "background") || typeof item.timezone !== "string" || !item.timezone.trim() ||
      (item.nextAt !== null && (typeof item.nextAt !== "number" || !Number.isSafeInteger(item.nextAt) || item.nextAt < 0 || item.nextAt > MAX_DATE_MS))) return fail();
  if (!item.timing || typeof item.timing !== "object" || Array.isArray(item.timing)) return fail();
  const timing = item.timing as Record<string, unknown>;
  let normalizedTiming: ConsoleAutomation["timing"];
  if (timing.type === "at" && typeof timing.at === "string" && Number.isFinite(Date.parse(timing.at))) normalizedTiming = { type: "at", at: timing.at };
  else if (timing.type === "cron" && typeof timing.expression === "string" && timing.expression.trim()) normalizedTiming = { type: "cron", expression: timing.expression };
  else return fail();
  if (item.executor !== undefined && !isAgentKind(item.executor)) return fail();
  const target = item.target === undefined ? undefined : parseTarget(item.target, fail);
  if (item.activeRunId !== undefined && typeof item.activeRunId !== "string" || item.lastOutcome !== undefined && item.lastOutcome !== "completed" && item.lastOutcome !== "failed") return fail();
  return { id: item.id, chatId: item.chatId, title: item.title, kind: item.kind, timing: normalizedTiming,
    timezone: item.timezone, status: item.status as AutomationStatus, nextAt: item.nextAt as number | null,
    ...(item.activeRunId ? { activeRunId: item.activeRunId as string } : {}),
    ...(item.lastOutcome ? { lastOutcome: item.lastOutcome as "completed" | "failed" } : {}),
    ...(item.executor ? { executor: item.executor as AgentKind } : {}), ...(target ? { target } : {}) };
}

function parseTarget(raw: unknown, fail: () => never): NonNullable<ConsoleAutomation["target"]> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail();
  const target = raw as Record<string, unknown>;
  if (typeof target.nodeId !== "string" || !target.nodeId || typeof target.sessionId !== "string" || !target.sessionId ||
      typeof target.sendRoute !== "string" || !target.sendRoute) return fail();
  return { nodeId: target.nodeId, sessionId: target.sessionId, sendRoute: target.sendRoute as SendRoute };
}

/** Codex or Claude Code behind a schedule; reminders and unrecorded targets have none. */
export function automationAgentKind(item: Pick<ConsoleAutomation, "kind" | "executor" | "target">): AgentKind | undefined {
  if (item.kind === "background") return item.executor;
  return item.kind === "session" && item.target ? targetAgentKind(item.target) : undefined;
}

export function parseAutomations(raw: unknown): ConsoleAutomation[] {
  if (raw === undefined) return [];
  if (Array.isArray(raw)) return raw.map(parseAutomation);
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Array.isArray((raw as Record<string, unknown>).items)) throw new Error("定时任务列表格式无效");
  return ((raw as { items: unknown[] }).items).map(parseAutomation);
}
