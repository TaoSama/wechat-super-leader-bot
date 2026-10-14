import type { DesktopObservation, Session } from "../types.js";
import { z } from "zod";
import { sanitizeModelMetadata } from "./model-metadata.js";
import { isTerminalSession, MAX_TERMINAL_OBSERVATION_AGE_MS } from "./terminal.js";

export const MAX_DESKTOP_OBSERVATION_AGE_MS = 45_000;
const modelObservedAtSchema = z.string().datetime({ offset: true });

export interface ModelObservation {
  model?: string;
  modelProvider?: string;
  reasoningEffort?: string;
  source: "codex-desktop" | "control-socket" | "unknown";
  observedAt?: string;
}

/** Select one complete source group; metadata never grants control permissions. */
export function selectModelObservation(session: Pick<Session, "model" | "modelProvider" | "reasoningEffort" | "observedAt" | "desktopObservation"> & Partial<Pick<Session, "id" | "provider">>,
  now = Date.now()): ModelObservation {
  if (isTerminalSession(session)) return { source: "unknown" };
  const desktop = session.desktopObservation;
  const desktopModel = sanitizeModelMetadata(desktop?.model);
  const source = desktopModel && modelObservedAtSchema.safeParse(desktop?.observedAt).success &&
    isDesktopObservationFresh(desktop, now) ? "codex-desktop" : "control-socket";
  const selected = source === "codex-desktop" ? desktop! : session;
  const model = sanitizeModelMetadata(selected.model);
  if (!model) return { source: "unknown" };
  const modelProvider = sanitizeModelMetadata(selected.modelProvider);
  const reasoningEffort = sanitizeModelMetadata(selected.reasoningEffort);
  return {
    source, model,
    ...(modelProvider === undefined ? {} : { modelProvider }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(modelObservedAtSchema.safeParse(selected.observedAt).success ? { observedAt: selected.observedAt } : {}),
  };
}

export interface ExecutionObservation {
  executionStatus: string;
  statusSource: "control-socket" | "codex-desktop" | "terminal";
}

export function isDesktopObservationFresh(observation: DesktopObservation | undefined, now = Date.now()): boolean {
  if (observation?.source !== "codex-desktop" || observation.availability !== "available" || !observation.observedAt) return false;
  const observedAt = Date.parse(observation.observedAt);
  return Number.isFinite(now) && Number.isFinite(observedAt) && observedAt <= now &&
    now - observedAt <= MAX_DESKTOP_OBSERVATION_AGE_MS;
}

/** Selects a read-only execution view without changing control permissions. */
export function selectExecutionObservation(session: Pick<Session, "status" | "desktopObservation"> & Partial<Pick<Session, "id" | "provider" | "observedAt">>,
  now = Date.now()): ExecutionObservation {
  if (isTerminalSession(session)) {
    const observedAt = Date.parse(session.observedAt ?? "");
    const fresh = modelObservedAtSchema.safeParse(session.observedAt).success && observedAt <= now &&
      now - observedAt <= MAX_TERMINAL_OBSERVATION_AGE_MS;
    return { executionStatus: fresh ? session.status || "unknown" : "unknown", statusSource: "terminal" };
  }
  const controlStatus = session.status || "unknown";
  const desktop = session.desktopObservation;
  if ((controlStatus === "notLoaded" || controlStatus === "unknown") && desktop &&
      desktop.status !== "unknown" && isDesktopObservationFresh(desktop, now)) {
    return { executionStatus: desktop.status, statusSource: "codex-desktop" };
  }
  return { executionStatus: controlStatus, statusSource: "control-socket" };
}
