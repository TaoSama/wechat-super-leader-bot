import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { checkGatewayHealth, HealthTracker, sanitizeErrorType } from "../../src/runtime/health.js";

test("Health tracker and checkGatewayHealth lifecycle and error sanitization", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-01-01T00:00:00Z") });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-health-test-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const healthPath = path.join(tmpDir, "health.json");

  // Health check fails when file doesn't exist
  const resMissing = checkGatewayHealth(healthPath, 120000);
  assert.equal(resMissing.ok, false);
  assert.equal(resMissing.reason, "HealthFileNotFound");

  // Start tracker and verify starting status
  const tracker = new HealthTracker(healthPath);
  tracker.startRun();
  const resStarting = checkGatewayHealth(healthPath, 120000);
  assert.equal(resStarting.ok, true);
  assert.equal(resStarting.status, "starting");
  assert.equal(resStarting.pid, process.pid);

  // Record error and verify error desensitization
  tracker.recordPollError(new Error("WeChat iLink HTTP 502 on /ilink/bot/getupdates"));
  const resDegraded = checkGatewayHealth(healthPath, 120000);
  assert.equal(resDegraded.consecutiveErrors, 1);
  assert.equal(resDegraded.lastErrorType, "ILinkHttp502");

  // Test error sanitizer never leaks arbitrary names
  assert.equal(sanitizeErrorType(new Error("WeChat getupdates failed")), "ILinkGetUpdatesError");
  assert.equal(sanitizeErrorType(new Error("Controller authentication/authorization failed (HTTP 403)")), "ControllerAuth403");
  assert.equal(sanitizeErrorType(new Error("Controller authentication failed (HTTP 401)")), "ControllerAuth401");
  assert.equal(sanitizeErrorType({ name: "CustomSensitiveErrorName123", message: "foo" }), "OperationalError");

  // Record poll success and verify healthy
  tracker.recordPollSuccess();
  const resHealthy = checkGatewayHealth(healthPath, 120000);
  assert.equal(resHealthy.ok, true);
  assert.equal(resHealthy.status, "healthy");
  assert.equal(resHealthy.consecutiveErrors, 0);

  // The exact age boundary is healthy; stale detection starts after it.
  const resAtBoundary = checkGatewayHealth(healthPath, 0);
  assert.equal(resAtBoundary.ok, true);
  assert.equal(resAtBoundary.ageMs, 0);
  t.mock.timers.tick(1);
  const resStale = checkGatewayHealth(healthPath, 0);
  assert.equal(resStale.ok, false);
  assert.equal(resStale.reason, "PollStale");
  assert.equal(resStale.ageMs, 1);

  // Stopped process
  tracker.recordStop();
  const resStopped = checkGatewayHealth(healthPath, 120000);
  assert.equal(resStopped.ok, false);
  assert.equal(resStopped.reason, "GatewayStopped");
});

test("Log error classification and output redaction verification", () => {
  // Test error sanitizer with raw tokens, messages, errcode strings
  const sensitiveLeak = new Error("WeChat iLink failed with sensitive_token_9999 and body: {\"secret\":123}");
  assert.equal(sanitizeErrorType(sensitiveLeak), "OperationalError");

  const timeoutErr = new Error("Request to ilinkai.weixin.qq.com/getupdates timed out after 35000ms");
  assert.equal(sanitizeErrorType(timeoutErr), "TimeoutError");

  const ctrl500 = new Error("Controller /v1/messages returned HTTP 500");
  assert.equal(sanitizeErrorType(ctrl500), "ControllerHttp500");

  const parseErr = new SyntaxError("Unexpected token in JSON at position 12");
  assert.equal(sanitizeErrorType(parseErr), "InvalidJsonSyntax");
});
