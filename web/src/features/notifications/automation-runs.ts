export type AutomationRunStatus = "dispatching" | "running" | "completed" | "failed" | "unknown" | "expired" | "skipped";

export interface ConsoleAutomationRun {
  id: string;
  scheduleId: string;
  scheduledAt: number;
  status: AutomationRunStatus;
  createdAt: number;
  updatedAt: number;
  commandId?: string;
  result?: { text: string; meaningful?: boolean; fingerprint?: string };
  error?: string;
}

const STATUSES = new Set<AutomationRunStatus>(["dispatching", "running", "completed", "failed", "unknown", "expired", "skipped"]);
const MAX_DATE_MS = 8_640_000_000_000_000;

function date(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_DATE_MS;
}

export function parseAutomationRun(raw: unknown, scheduleId: string): ConsoleAutomationRun {
  const fail = (): never => { throw new Error("定时任务执行记录格式无效"); };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail();
  const item = raw as Record<string, unknown>;
  if (typeof item.id !== "string" || !item.id.trim() || item.scheduleId !== scheduleId ||
      !STATUSES.has(item.status as AutomationRunStatus) || !date(item.scheduledAt) ||
      !date(item.createdAt) || !date(item.updatedAt)) return fail();
  if (item.commandId !== undefined && (typeof item.commandId !== "string" || !item.commandId.trim())) return fail();
  if (item.error !== undefined && typeof item.error !== "string") return fail();
  let result: ConsoleAutomationRun["result"];
  if (item.result !== undefined) {
    if (!item.result || typeof item.result !== "object" || Array.isArray(item.result)) return fail();
    const value = item.result as Record<string, unknown>;
    if (typeof value.text !== "string" || (value.meaningful !== undefined && typeof value.meaningful !== "boolean") ||
        (value.fingerprint !== undefined && typeof value.fingerprint !== "string")) return fail();
    result = { text: value.text, ...(value.meaningful !== undefined ? { meaningful: value.meaningful } : {}), ...(value.fingerprint ? { fingerprint: value.fingerprint } : {}) };
  }
  return { id: item.id, scheduleId, scheduledAt: item.scheduledAt, status: item.status as AutomationRunStatus,
    createdAt: item.createdAt, updatedAt: item.updatedAt, ...(item.commandId ? { commandId: item.commandId as string } : {}),
    ...(result ? { result } : {}), ...(item.error ? { error: item.error as string } : {}) };
}

export function parseAutomationRuns(raw: unknown, scheduleId: string): ConsoleAutomationRun[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Array.isArray((raw as Record<string, unknown>).items)) {
    throw new Error("定时任务执行记录列表格式无效");
  }
  return ((raw as { items: unknown[] }).items).map(item => parseAutomationRun(item, scheduleId));
}
