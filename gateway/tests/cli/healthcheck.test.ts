import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runCli } from "../../src/cli/run.js";
import { HealthTracker } from "../../src/runtime/health.js";

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
