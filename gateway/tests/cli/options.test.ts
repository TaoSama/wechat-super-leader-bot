import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGatewayCli } from "../../src/cli/options.js";

test("CLI parseGatewayCli mode mutual exclusivity and env handling", () => {
  // Disallow multiple modes
  assert.throws(
    () => parseGatewayCli(["--check", "--run"]),
    /Cannot specify multiple mode flags simultaneously/
  );
  assert.throws(
    () => parseGatewayCli(["--establish-baseline", "--run"]),
    /Cannot specify multiple mode flags simultaneously/
  );
  assert.throws(
    () => parseGatewayCli(["--healthcheck", "--poll-once"]),
    /Cannot specify multiple mode flags simultaneously/
  );

  // Explicit --check or --establish-baseline or --healthcheck ignores GATEWAY_RUN_POLL=true
  const optsBaseline = parseGatewayCli(["--establish-baseline"], { GATEWAY_RUN_POLL: "true" });
  assert.equal(optsBaseline.mode, "establish-baseline");
  assert.equal(optsBaseline.run, false);

  const optsCheck = parseGatewayCli(["--check"], { GATEWAY_RUN_POLL: "true" });
  assert.equal(optsCheck.mode, "check");
  assert.equal(optsCheck.run, false);

  const optsHealth = parseGatewayCli(["--healthcheck"], { GATEWAY_RUN_POLL: "true" });
  assert.equal(optsHealth.mode, "healthcheck");
  assert.equal(optsHealth.run, false);

  // When no mode flag is provided, GATEWAY_RUN_POLL triggers run mode
  const optsRunFromEnv = parseGatewayCli([], { GATEWAY_RUN_POLL: "true" });
  assert.equal(optsRunFromEnv.mode, "run");
  assert.equal(optsRunFromEnv.run, true);
});
