import type { AutomationRun } from "./contracts.js";

export function validateBodyRetention(now: number, retentionMs: number): void {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(retentionMs) || retentionMs < 0) {
    throw new Error("Invalid automation body retention");
  }
}
export function clearRunBody(run: AutomationRun, now: number): void {
  if (run.result) {
    run.result.text = "";
    delete run.result.error;
  }
  delete run.error;
  run.bodyClearedAt = now;
}
