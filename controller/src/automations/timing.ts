import { CronExpressionParser } from "cron-parser";
import type { Schedule, CreateSchedule } from "./contracts.js";
import { AutomationValidationError } from "./errors.js";

export const BACKGROUND_IMMEDIATE_TOLERANCE_MS = 5 * 60_000;
export function validateTiming(input: CreateSchedule, now: number): number {
  try { new Intl.DateTimeFormat("en", { timeZone: input.timezone }).format(now); }
  catch (error) {
    if (!(error instanceof RangeError)) throw error;
    throw new AutomationValidationError("Invalid IANA timezone", { cause: error });
  }
  if (input.timing.type === "at") {
    const at = Date.parse(input.timing.at);
    if (at <= now && !(input.kind === "background" && at >= now - BACKGROUND_IMMEDIATE_TOLERANCE_MS)) {
      throw new AutomationValidationError(input.kind === "background" ? "Background time is older than the five-minute immediate-start window" : "Scheduled time must be in the future");
    }
    return at;
  }
  if (input.timing.expression.trim().split(/\s+/).length !== 5) throw new AutomationValidationError("Cron must contain five fields (minute precision)");
  try {
    return CronExpressionParser.parse(input.timing.expression, { currentDate: new Date(now), tz: input.timezone }).next().getTime();
  } catch (error) {
    throw new AutomationValidationError("Invalid cron expression or no future occurrence", { cause: error });
  }
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
