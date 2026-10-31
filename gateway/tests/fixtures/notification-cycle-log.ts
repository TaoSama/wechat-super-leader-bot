import assert from "node:assert/strict";

export function parseNotificationCycle(line: string): Record<string, unknown> | undefined {
  if (!line.startsWith("{")) return undefined;
  const event = JSON.parse(line) as Record<string, unknown>;
  if (!["notification_cycle_ready", "notification_cycle_failed", "notification_cycle_recovered"].includes(event.event as string)) return undefined;
  assert.equal(event.service, "gateway");
  assert.equal(typeof event.timestamp, "string");
  assert.equal(new Date(event.timestamp as string).toISOString(), event.timestamp);
  const requestFields = ["stage", "operation", "phase", "requestAttempts", "requestMaxAttempts", "elapsedMs",
    "timedOut", "parentAborted", "httpStatus", "errorName", "causeCodes"];
  const fields = event.event === "notification_cycle_failed" ? [...requestFields, "errorType", "consecutiveFailures",
    "totalFailures", "lastSucceededAt", "retryScheduled", "retryDelayMs", "failedRequests", "unresolvedFailures",
    "recoveryEvidenceOverflow"] : event.event === "notification_cycle_recovered" ? ["totalFailures", "elapsedMs", "recoveredOperations"] : [];
  function validate(record: Record<string, unknown>, allowed: string[]): void {
    for (const [key, value] of Object.entries(record)) {
      assert.ok(allowed.includes(key), `unexpected notification cycle field: ${key}`);
      if (key === "failedRequests") {
        assert.ok(Array.isArray(value));
        for (const failure of value) { assert.ok(failure && typeof failure === "object"); validate(failure, requestFields); }
      } else if (key === "causeCodes" || key === "recoveredOperations") {
        assert.ok(Array.isArray(value));
        assert.ok(value.every(item => typeof item === "string" && item.length <= 128));
      } else {
        assert.ok(value === null || ["string", "number", "boolean"].includes(typeof value), key);
        if (typeof value === "number") assert.ok(Number.isFinite(value) && value >= 0, key);
        if (typeof value === "string") assert.ok(value.length <= 128, key);
      }
    }
  }
  validate(event, ["event", "service", "timestamp", ...fields]);
  return event;
}
