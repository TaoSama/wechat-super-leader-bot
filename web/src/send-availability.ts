import type { ScopedSession, SendAvailability, SendRoute } from "./types";
import { isDesktopObservationFresh, isIsoTimestamp, normalizeDesktopObservation } from "./session-observation";
import { isTerminalSession, TERMINAL_READ_ONLY_REASON } from "./terminal-session";

export const MAX_SEND_AVAILABILITY_AGE_MS = 45_000;
const AVAILABILITY_KEYS = new Set(["route", "state", "observedAt", "validUntil", "reason"]);
const REASONS = new Set(["busy", "preflight-rejected", "unavailable", "checking"]);

// An invalid, present qualification is retained as an explicit denial. Dropping
// it would accidentally authorize the unrelated control-socket fallback.
export function normalizeSendAvailability(raw: unknown): SendAvailability | undefined {
  if (raw === undefined) return undefined;
  const unavailable: SendAvailability = { route: "desktop-owner", state: "unavailable", observedAt: "", validUntil: "", reason: "unavailable" };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return unavailable;
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some(key => !AVAILABILITY_KEYS.has(key)) || value.route !== "desktop-owner" ||
      !["ready", "blocked", "unavailable"].includes(String(value.state)) ||
      !isIsoTimestamp(value.observedAt) || !isIsoTimestamp(value.validUntil) ||
      value.reason !== undefined && !REASONS.has(String(value.reason))) return unavailable;
  return { route: "desktop-owner", state: value.state as SendAvailability["state"], observedAt: value.observedAt,
    validUntil: value.validUntil, reason: value.reason as SendAvailability["reason"] };
}

export function isSendAvailabilityFresh(availability: SendAvailability, now = Date.now()): boolean {
  const observedAt = Date.parse(availability.observedAt);
  const validUntil = Date.parse(availability.validUntil);
  return Number.isFinite(now) && Number.isFinite(observedAt) && Number.isFinite(validUntil) &&
    observedAt <= now && now < validUntil && validUntil > observedAt && validUntil - observedAt <= MAX_SEND_AVAILABILITY_AGE_MS;
}

export function sessionSendBlockReason(session: ScopedSession, now = Date.now()): string | null {
  if (isTerminalSession(session)) return TERMINAL_READ_ONLY_REASON;
  const availability = normalizeSendAvailability(session.sendAvailability);
  if (availability) {
    if (availability.state !== "ready") {
      switch (availability.reason) {
        case "checking": return "正在检查原桌面会话的发送通道…";
        case "busy": return "会话正在执行或等待处理，请在本轮结束后发送";
        case "preflight-rejected": return "原桌面会话暂不接受发送，请检查桌面的执行或审批状态";
        default: return "原桌面发送通道暂不可用，请保持桌面应用与会话在线";
      }
    }
    if (!isSendAvailabilityFresh(availability, now)) return "发送资格已过期或时间异常，等待自动更新";
    if (session.desktopObservation !== undefined) {
      const desktop = normalizeDesktopObservation(session.desktopObservation);
      if (!desktop || !isDesktopObservationFresh(desktop, now)) return "桌面状态待更新，暂不可发送";
      if (desktop.status !== "idle") return desktop.status === "active" ? "桌面会话正在执行，请等待本轮结束" : "桌面会话状态未知，暂不可发送";
    }
    return null;
  }
  if (session.loaded !== true || session.status === "notLoaded") return "当前控制接口未加载此会话，暂时只读";
  if (session.status !== "idle") return ["active", "busy", "running"].includes(session.status) ? "会话正在执行，请等待本轮结束" : "会话状态未知，暂不可发送";
  if (!session.capabilities.includes("send")) return "会话尚未报告发送能力";
  const observedAt = isIsoTimestamp(session.observedAt) ? Date.parse(session.observedAt) : NaN;
  if (!Number.isFinite(now) || !Number.isFinite(observedAt) || observedAt > now || now - observedAt > MAX_SEND_AVAILABILITY_AGE_MS) return "控制状态待更新，暂不可发送";
  return null;
}

export function sendRouteLabel(route: SendRoute): string {
  return route === "desktop-owner" ? "原桌面会话" : "宿主控制接口";
}
