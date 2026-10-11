import type { DesktopObservation, ScopedSession } from "./types";
import { formatTimestamp } from "./format";

export const MAX_DESKTOP_OBSERVATION_AGE_MS = 45_000;
export const MAX_MODEL_FIELD_BYTES = 256;
const modelFieldEncoder = new TextEncoder();
const ISO_TIMESTAMP_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const DESKTOP_STATUS_NAMES = { active: "执行中", idle: "空闲", unknown: "状态未知" };

export function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_TIMESTAMP_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) return false;
  const calendarDate = value.slice(0, 10);
  const midnight = Date.parse(`${calendarDate}T00:00:00Z`);
  return Number.isFinite(midnight) && new Date(midnight).toISOString().slice(0, 10) === calendarDate;
}

/** Invalid metadata is omitted, never clipped into a different model name. */
export function normalizeModelField(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.trim() !== value ||
      /[\p{Cc}\p{Cs}\uFFFD]/u.test(value) || modelFieldEncoder.encode(value).length > MAX_MODEL_FIELD_BYTES) return undefined;
  return value;
}

export function normalizeDesktopObservation(raw: unknown): DesktopObservation | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (value.source !== "codex-desktop" ||
      (value.status !== "active" && value.status !== "idle" && value.status !== "unknown") ||
      (value.availability !== "available" && value.availability !== "unavailable")) return undefined;
  if (value.observedAt !== undefined && !isIsoTimestamp(value.observedAt)) return undefined;
  const model = normalizeModelField(value.model);
  const modelProvider = normalizeModelField(value.modelProvider);
  const reasoningEffort = normalizeModelField(value.reasoningEffort);
  return { status: value.status, availability: value.availability, source: value.source,
    observedAt: value.observedAt as string | undefined,
    ...(model ? { model } : {}), ...(modelProvider ? { modelProvider } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}) };
}

export function isDesktopObservationFresh(observation: DesktopObservation | undefined, now = Date.now()): boolean {
  if (observation?.source !== "codex-desktop" || observation.availability !== "available" || !observation.observedAt) return false;
  const observedAt = Date.parse(observation.observedAt);
  return Number.isFinite(now) && Number.isFinite(observedAt) && observedAt <= now &&
    now - observedAt <= MAX_DESKTOP_OBSERVATION_AGE_MS;
}

/** Display-only status; this observation never grants send permission. */
export function selectExecutionObservation(session: Pick<ScopedSession, "status" | "desktopObservation">,
  now = Date.now()): { executionStatus: string; statusSource: "control-socket" | "codex-desktop" } {
  const controlStatus = session.status || "unknown";
  const desktop = session.desktopObservation;
  if ((controlStatus === "notLoaded" || controlStatus === "unknown") && desktop &&
      desktop.status !== "unknown" && isDesktopObservationFresh(desktop, now)) {
    return { executionStatus: desktop.status, statusSource: "codex-desktop" };
  }
  return { executionStatus: controlStatus, statusSource: "control-socket" };
}

export function describeDesktopObservation(observation: DesktopObservation | undefined, now = Date.now()): string | null {
  if (!observation) return null;
  const observedAt = observation.observedAt ? Date.parse(observation.observedAt) : NaN;
  const condition = observation.availability === "unavailable" ? "已失联" :
    !Number.isFinite(observedAt) ? "未取得观测时间" : observedAt > now ? "观测时间异常" :
      !isDesktopObservationFresh(observation, now) ? "观测已过期" : "观测";
  const time = observation.observedAt ? ` · ${formatTimestamp(observation.observedAt)}` : "";
  const status = condition === "观测" ? DESKTOP_STATUS_NAMES[observation.status] :
    observedAt <= now ? `上次${DESKTOP_STATUS_NAMES[observation.status]}` : "状态未知";
  return `桌面${condition} · ${status}${time}`;
}
