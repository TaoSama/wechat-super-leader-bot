import { sessionRequest } from "./request";
import { parseAutomation, type ConsoleAutomation, type AutomationStatus } from "../features/notifications/automation-contract";
import { parseAutomationRuns, type ConsoleAutomationRun } from "../features/notifications/automation-runs";

export async function changeAutomationStatus(item: ConsoleAutomation, status: Exclude<AutomationStatus, "completed">, signal?: AbortSignal): Promise<ConsoleAutomation> {
  const raw = await sessionRequest(`/v1/automations/${encodeURIComponent(item.id)}/status`, {
    method: "POST", credentials: "same-origin",
    headers: { "Content-Type": "application/json", Accept: "application/json", "X-Super-Leader-Intent": "automation-status" },
    body: JSON.stringify({ chatId: item.chatId, status }), signal,
  });
  if (!raw || typeof raw !== "object" || !("schedule" in raw)) throw new Error("定时任务回执格式无效，请刷新核验");
  const schedule = parseAutomation(raw.schedule);
  if (schedule.id !== item.id || schedule.chatId !== item.chatId || schedule.status !== status) throw new Error("定时任务回执与当前操作不匹配，请刷新核验");
  return schedule;
}

export async function fetchAutomationRuns(item: ConsoleAutomation, signal?: AbortSignal): Promise<ConsoleAutomationRun[]> {
  const raw = await sessionRequest(`/v1/automations/${encodeURIComponent(item.id)}/runs?chatId=${encodeURIComponent(item.chatId)}`, {
    method: "GET", headers: { Accept: "application/json" }, signal,
  });
  return parseAutomationRuns(raw, item.id);
}
