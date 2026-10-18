import { createHash } from "node:crypto";
import type { CreateSchedule, Schedule } from "./contracts.js";
import { AutomationConflictError } from "./errors.js";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}
const UUID_DNS_NAMESPACE = Buffer.from("6ba7b8109dad11d180b400c04fd430c8", "hex");
function namedUuid(identity: unknown[]): string {
  const bytes = createHash("sha1").update(UUID_DNS_NAMESPACE)
    .update(JSON.stringify(identity)).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = bytes.toString("hex");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

/** Replaying the same authorized tool request cannot create another recurring job. */
export function automationId(chatId: string, messageId: string, input: CreateSchedule): string {
  return namedUuid(["wechat-automation", chatId, messageId, canonical(input)]);
}
/** HTTP keys identify one creation attempt independently of its payload. */
export function automationRequestId(chatId: string, key: string): string {
  return namedUuid(["wechat-automation-http", chatId, key]);
}
export function supplementId(runId: string, invocationId: string): string {
  return namedUuid(["wechat-background-supplement", runId, invocationId]);
}

function creationSpec(schedule: Schedule): CreateSchedule {
  const base = { title: schedule.title, timing: schedule.timing, timezone: schedule.timezone,
    businessTtlMs: schedule.businessTtlMs, retention: schedule.retention };
  if (schedule.kind === "reminder") return { ...base, kind: "reminder", text: schedule.text };
  if (schedule.kind === "background") return { ...base, kind: "background", background: schedule.background };
  return { ...base, kind: "session", prompt: schedule.prompt, nodeId: schedule.nodeId, sessionId: schedule.sessionId, monitor: schedule.monitor };
}
export function assertSameCreation(existing: Schedule, incoming: Schedule): void {
  if (automationId(existing.chatId, existing.authorizedMessageId, creationSpec(existing)) !==
      automationId(incoming.chatId, incoming.authorizedMessageId, creationSpec(incoming))) {
    throw new AutomationConflictError("Schedule identity conflicts with another creation request");
  }
}
