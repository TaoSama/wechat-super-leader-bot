export type AutomationStatus = "active" | "paused" | "cancelled" | "completed";
export interface ConsoleAutomation {
  id: string;
  chatId: string;
  title: string;
  kind: "reminder" | "session";
  timing: { type: "at"; at: string } | { type: "cron"; expression: string };
  timezone: string;
  status: AutomationStatus;
  nextAt: number | null;
  activeRunId?: string;
  lastOutcome?: "completed" | "failed";
}

const STATUSES = new Set(["active", "paused", "cancelled", "completed"]);
const MAX_DATE_MS = 8_640_000_000_000_000;

export function parseAutomation(raw: unknown): ConsoleAutomation {
  const fail = (): never => { throw new Error("定时任务状态格式无效"); };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail();
  const item = raw as Record<string, unknown>;
  if (typeof item.id !== "string" || !item.id.trim() || typeof item.chatId !== "string" || !item.chatId.trim() ||
      typeof item.title !== "string" || !item.title.trim() || !STATUSES.has(String(item.status)) ||
      (item.kind !== "reminder" && item.kind !== "session") || typeof item.timezone !== "string" || !item.timezone.trim() ||
      (item.nextAt !== null && (typeof item.nextAt !== "number" || !Number.isSafeInteger(item.nextAt) || item.nextAt < 0 || item.nextAt > MAX_DATE_MS))) return fail();
  if (!item.timing || typeof item.timing !== "object" || Array.isArray(item.timing)) return fail();
  const timing = item.timing as Record<string, unknown>;
  let normalizedTiming: ConsoleAutomation["timing"];
  if (timing.type === "at" && typeof timing.at === "string" && Number.isFinite(Date.parse(timing.at))) normalizedTiming = { type: "at", at: timing.at };
  else if (timing.type === "cron" && typeof timing.expression === "string" && timing.expression.trim()) normalizedTiming = { type: "cron", expression: timing.expression };
  else return fail();
  if (item.activeRunId !== undefined && typeof item.activeRunId !== "string" || item.lastOutcome !== undefined && item.lastOutcome !== "completed" && item.lastOutcome !== "failed") return fail();
  return { id: item.id, chatId: item.chatId, title: item.title, kind: item.kind, timing: normalizedTiming,
    timezone: item.timezone, status: item.status as AutomationStatus, nextAt: item.nextAt as number | null,
    ...(item.activeRunId ? { activeRunId: item.activeRunId as string } : {}),
    ...(item.lastOutcome ? { lastOutcome: item.lastOutcome as "completed" | "failed" } : {}) };
}

export function parseAutomations(raw: unknown): ConsoleAutomation[] {
  if (raw === undefined) return [];
  if (Array.isArray(raw)) return raw.map(parseAutomation);
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Array.isArray((raw as Record<string, unknown>).items)) throw new Error("定时任务列表格式无效");
  return ((raw as { items: unknown[] }).items).map(parseAutomation);
}
