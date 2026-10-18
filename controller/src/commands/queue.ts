import { type CommandAuthority, type CommandRecord, type PostCommandRequest, type SendRoute, type Session } from "../types.js";
import { sameSkillRefs } from "../skills/catalog.js";
import { selectSendRoute } from "../sessions/send-eligibility.js";

export const QUEUE_BATCH_SIZE = 64;
export const QUEUE_TICK_MS = 1000;
export const ACTIVE_COMMAND_STATUSES = ["pending", "accepted", "uncertain"];

export function sameCommandPayload(a: CommandRecord, b: PostCommandRequest): boolean {
  return a.nodeId === b.nodeId && a.sessionId === b.sessionId && a.action === b.action &&
    (a.prompt ?? "") === (b.prompt ?? "") && sameSkillRefs(a.skills, b.skills) &&
    (a.deliveryMode ?? "next-turn") === (b.deliveryMode ?? "next-turn") && a.expectedTurnId === b.expectedTurnId;
}

/** Historical capability is target identity evidence only. Dispatch always rechecks live authority. */
export function queueSendRoute(session: Session, expected?: SendRoute): SendRoute | undefined {
  const live = selectSendRoute(session, Date.now(), expected);
  if (live.ready) return !expected || live.route === expected ? live.route : undefined;
  let route: SendRoute | undefined;
  if (session.id.startsWith("terminal:") || session.provider.startsWith("terminal")) return undefined;
  if (session.sendAvailability?.route === "desktop-owner") route = "desktop-owner";
  else if (session.capabilities.includes("resume-send") && session.loaded === false) route = "app-server-resume";
  else if (session.capabilities.includes("send")) route = "control-socket";
  else if (session.capabilities.includes("resume-send")) route = "app-server-resume";
  return !expected || route === expected ? route : undefined;
}

export function sameAuthority(a: CommandAuthority | undefined, b: CommandAuthority | undefined): boolean {
  const left = a ?? { type: "admin" }, right = b ?? { type: "admin" };
  if (left.type !== right.type) return false;
  switch (left.type) {
    case "admin": return true;
    case "chat": return right.type === "chat" && left.chatId === right.chatId;
    case "automation": return right.type === "automation" && left.chatId === right.chatId &&
      left.scheduleId === right.scheduleId && left.runId === right.runId;
    case "console": return right.type === "console" && left.tokenHash === right.tokenHash && left.expiresAt === right.expiresAt;
    case "plan": case "goal": return (right.type === "plan" || right.type === "goal") && left.id === right.id && left.chatId === right.chatId;
  }
}

export function beforeInQueue(a: CommandRecord, b: CommandRecord): boolean {
  return (a.queueOrder ?? 0) < (b.queueOrder ?? 0) || a.queueOrder === b.queueOrder &&
    (a.createdAt < b.createdAt || a.createdAt === b.createdAt && a.commandId < b.commandId);
}
