import type { DesktopObservation, Session } from "./types.js";
import { z } from "zod";
import { sanitizeModelMetadata } from "./model-metadata.js";

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
export function selectModelObservation(session: Pick<Session, "model" | "modelProvider" | "reasoningEffort" | "observedAt" | "desktopObservation">,
  now = Date.now()): ModelObservation {
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
  statusSource: "control-socket" | "codex-desktop";
}

export function isDesktopObservationFresh(observation: DesktopObservation | undefined, now = Date.now()): boolean {
  if (observation?.source !== "codex-desktop" || observation.availability !== "available" || !observation.observedAt) return false;
  const observedAt = Date.parse(observation.observedAt);
  return Number.isFinite(now) && Number.isFinite(observedAt) && observedAt <= now &&
    now - observedAt <= MAX_DESKTOP_OBSERVATION_AGE_MS;
}

/** Selects a read-only execution view without changing control permissions. */
export function selectExecutionObservation(session: Pick<Session, "status" | "desktopObservation">,
  now = Date.now()): ExecutionObservation {
  const controlStatus = session.status || "unknown";
  const desktop = session.desktopObservation;
  if ((controlStatus === "notLoaded" || controlStatus === "unknown") && desktop &&
      desktop.status !== "unknown" && isDesktopObservationFresh(desktop, now)) {
    return { executionStatus: desktop.status, statusSource: "codex-desktop" };
  }
  return { executionStatus: controlStatus, statusSource: "control-socket" };
}
