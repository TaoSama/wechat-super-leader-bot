import { CronExpressionParser } from "cron-parser";
import type { Schedule, CreateSchedule } from "./contracts.js";

export function validateTiming(input: CreateSchedule, now: number): number {
  try { new Intl.DateTimeFormat("en", { timeZone: input.timezone }).format(now); }
  catch { throw new Error("Invalid IANA timezone"); }
  if (input.timing.type === "at") {
    const at = Date.parse(input.timing.at);
    if (at <= now) throw new Error("Scheduled time must be in the future");
    return at;
  }
  if (input.timing.expression.trim().split(/\s+/).length !== 5) throw new Error("Cron must contain five fields (minute precision)");
  return CronExpressionParser.parse(input.timing.expression, { currentDate: new Date(now), tz: input.timezone }).next().getTime();
}

/** A downtime gap becomes one newest occurrence, never a replay of every missed tick. */
export function dueOccurrence(schedule: Schedule, now: number): { scheduledAt: number; nextAt: number | null } {
  if (schedule.timing.type === "at") return { scheduledAt: schedule.nextAt!, nextAt: null };
  const expression = schedule.timing.expression;
  const options = { currentDate: new Date(now + 1), tz: schedule.timezone };
  const previous = CronExpressionParser.parse(expression, options).prev().getTime();
  const scheduledAt = Math.max(schedule.nextAt!, previous);
  const nextAt = CronExpressionParser.parse(expression, { currentDate: new Date(now), tz: schedule.timezone }).next().getTime();
  return { scheduledAt, nextAt };
}
