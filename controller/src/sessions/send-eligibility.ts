import { z } from "zod";
import { DesktopObservationSchema, SendAvailabilitySchema, SendRoute, Session } from "../types.js";
import { MAX_DESKTOP_OBSERVATION_AGE_MS } from "./observation.js";
import { isTerminalSession } from "./terminal.js";
import { TerminalSessionIdSchema } from "./input-receipt.js";

const isoTimestamp = z.string().datetime({ offset: true });
type SendEligibility = { ready: true; route: SendRoute } | { ready: false; httpStatus: number; reason: string };
const blocked = (reason: string, httpStatus = 409): SendEligibility => ({ ready: false, httpStatus, reason });

function freshTimestamp(value: unknown, now: number): boolean {
  if (!isoTimestamp.safeParse(value).success || !Number.isFinite(now)) return false;
  const observed = Date.parse(value as string);
  return observed <= now && now - observed <= MAX_DESKTOP_OBSERVATION_AGE_MS;
}

/** A present desktop authority, including an invalid one, never falls back to native control. */
export function selectSendRoute(session: Session, now = Date.now()): SendEligibility {
  const terminal = isTerminalSession(session);
  if (terminal && !Object.hasOwn(session, "sendAvailability")) return blocked("Terminal sessions support observation only; sending is unavailable");
  if (Object.hasOwn(session, "sendAvailability")) {
    const parsed = SendAvailabilitySchema.safeParse(session.sendAvailability);
    if (!parsed.success || parsed.data.state !== "ready") return blocked("Send authority is unavailable or blocked");
    if (terminal !== (parsed.data.route === "terminal-pane") || terminal && !TerminalSessionIdSchema.safeParse(session.id).success) return blocked("Send authority does not match the target route");
    const { observedAt, validUntil } = parsed.data;
    const observed = Date.parse(observedAt), until = Date.parse(validUntil);
    if (!Number.isFinite(now) || observed > now || now >= until || until <= observed ||
        until - observed > MAX_DESKTOP_OBSERVATION_AGE_MS) return blocked("Send authority is expired or invalid");
    if (!terminal && Object.hasOwn(session, "desktopObservation")) {
      const observation = DesktopObservationSchema.safeParse(session.desktopObservation);
      if (!observation.success || observation.data.availability !== "available" || observation.data.status !== "idle" ||
          !freshTimestamp(observation.data.observedAt, now)) return blocked("Desktop session is not freshly observed idle");
    }
    return { ready: true, route: parsed.data.route };
  }
  if (!session.capabilities.includes("send")) return blocked("Target does not support this action", 400);
  if (session.status !== "idle" || session.loaded !== true) return blocked("Target session is not idle or not loaded");
  if (!freshTimestamp(session.observedAt, now)) return blocked("Target session observation is expired or invalid");
  return { ready: true, route: "control-socket" };
}
