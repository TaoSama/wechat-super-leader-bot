import type { ScopedSession } from "./types";
import { isDesktopObservationFresh, isIsoTimestamp, normalizeModelField } from "./session-observation";
import { isTerminalSession } from "./terminal-session";

export interface ModelObservation {
  model?: string;
  modelProvider?: string;
  reasoningEffort?: string;
  source: "codex-desktop" | "control-socket" | "unknown";
  observedAt?: string;
}

type ModelSession = Pick<ScopedSession, "model" | "modelProvider" | "reasoningEffort" | "observedAt" | "desktopObservation"> & Partial<Pick<ScopedSession, "id" | "provider">>;

/** Select an entire read-only group; never combine settings from two sources. */
export function selectModelObservation(session: ModelSession, now = Date.now()): ModelObservation {
  if (isTerminalSession(session)) return { source: "unknown" };
  const desktop = session.desktopObservation;
  const desktopModel = normalizeModelField(desktop?.model);
  if (desktopModel && desktop && isIsoTimestamp(desktop.observedAt) && isDesktopObservationFresh(desktop, now)) {
    return { model: desktopModel, modelProvider: normalizeModelField(desktop.modelProvider),
      reasoningEffort: normalizeModelField(desktop.reasoningEffort), source: "codex-desktop", observedAt: desktop.observedAt };
  }
  const model = normalizeModelField(session.model);
  if (!model) return { source: "unknown" };
  return { model, modelProvider: normalizeModelField(session.modelProvider),
    reasoningEffort: normalizeModelField(session.reasoningEffort), source: "control-socket",
    observedAt: isIsoTimestamp(session.observedAt) ? session.observedAt : undefined };
}

export function modelSourceLabel(source: ModelObservation["source"]): string {
  return source === "codex-desktop" ? "桌面会话设置" : source === "control-socket" ? "控制接口记录" : "未报告";
}
