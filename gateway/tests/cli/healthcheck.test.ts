import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runCli } from "../../src/cli/run.js";
import { checkGatewayHealth, HealthTracker, type GatewayHealthData } from "../../src/runtime/health.js";
import { MAX_POLL_PHASE_MS, MAX_PROCESSING_PHASE_MS } from "../../src/runtime/budgets.js";

test("CLI --healthcheck runs independently without requiring credentials", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-cli-health-"));
  const healthPath = path.join(tmpDir, "health.json");

  const tracker = new HealthTracker(healthPath);
  tracker.startRun();
  tracker.recordPollSuccess();

  // Call runCli with --healthcheck pointing to non-existent credentials path
  const code = await runCli(["--healthcheck", "--health-path", healthPath, "--credentials-path", "/non-existent/account.json"]);
  assert.equal(code, 0);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

for (const phase of [
  { name: "processing", budgetMs: MAX_PROCESSING_PHASE_MS },
  { name: "polling", budgetMs: MAX_POLL_PHASE_MS },
] as const) {
  test(`CLI --healthcheck accepts the maximum ${phase.name} budget across clock samples`, async t => {
    const startedAtMs = Date.parse("2026-01-01T00:00:00Z");
    t.mock.timers.enable({ apis: ["Date"], now: startedAtMs });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-cli-health-phase-"));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    const healthPath = path.join(tmpDir, "health.json");
    const tracker = new HealthTracker(healthPath);
    tracker.startRun();

    // A zero-argument Date samples just before the next Date.now() millisecond.
    let nowMs = startedAtMs + 1;
    t.mock.method(Date, "now", () => nowMs);
    if (phase.name === "processing") tracker.recordMessageStart(phase.budgetMs);
    else tracker.recordPollStart(phase.budgetMs);

    assert.equal(await runCli(["--healthcheck", "--health-path", healthPath,
      "--credentials-path", "/non-existent/account.json"], {}), 0);
    const persisted = JSON.parse(fs.readFileSync(healthPath, "utf8")) as GatewayHealthData;
    assert.ok(persisted.phase);
    assert.equal(persisted.phase.name, phase.name);
    const phaseStartMs = Date.parse(persisted.phase.started_at);
    const deadlineMs = Date.parse(persisted.phase.deadline_at);
    assert.equal(deadlineMs - phaseStartMs, phase.budgetMs);

    nowMs = deadlineMs;
    assert.equal(checkGatewayHealth(healthPath).ok, true);
    nowMs++;
    assert.equal(checkGatewayHealth(healthPath).reason, "ProcessingDeadlineExceeded");
  });
}
