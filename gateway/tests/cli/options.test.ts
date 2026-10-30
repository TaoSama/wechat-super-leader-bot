import { test } from "node:test";
import assert from "node:assert/strict";
import { getHelpText, parseGatewayCli } from "../../src/cli/options.js";

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

test("message chunk budget defaults to 3800 UTF-16 units with CLI overriding environment", () => {
  assert.equal(parseGatewayCli([], {}).maxChars, 3800);
  assert.equal(parseGatewayCli([], { GATEWAY_MAX_CHARS: "2400" }).maxChars, 2400);
  assert.equal(parseGatewayCli(["--max-chars", "1200"], { GATEWAY_MAX_CHARS: "2400" }).maxChars, 1200);
  assert.equal(parseGatewayCli(["--max-chars", "1200"], { GATEWAY_MAX_CHARS: "invalid" }).maxChars, 1200);
  assert.equal(parseGatewayCli(["--max-chars", "1"], {}).maxChars, 1);
  assert.equal(parseGatewayCli([], { GATEWAY_MAX_CHARS: String(Number.MAX_SAFE_INTEGER) }).maxChars, Number.MAX_SAFE_INTEGER);
  assert.match(getHelpText(), /--max-chars[^\n]*GATEWAY_MAX_CHARS[^\n]*3800/);
});

test("message chunk budget rejects nonpositive, fractional, nonfinite and unsafe values from CLI or environment", () => {
  const invalid = ["", "0", "-1", "1.5", "NaN", "Infinity", "-Infinity", String(Number.MAX_SAFE_INTEGER + 1)];
  for (const value of invalid) {
    assert.throws(() => parseGatewayCli([`--max-chars=${value}`], {}), /Invalid max-chars/, `CLI accepted ${JSON.stringify(value)}`);
    assert.throws(() => parseGatewayCli([], { GATEWAY_MAX_CHARS: value }), /Invalid max-chars/, `environment accepted ${JSON.stringify(value)}`);
  }
});

const POLICY_OPTIONS = [
  { option: "context-window-ms", environment: "GATEWAY_CONTEXT_WINDOW_MS", field: "contextWindowMs", default: 86_400_000, maximum: 604_800_000, configured: 82_800_000 },
  { option: "send-budget", environment: "GATEWAY_SEND_BUDGET", field: "sendBudget", default: 10, maximum: 1000, configured: 20 },
  { option: "outbox-limit", environment: "GATEWAY_OUTBOX_LIMIT", field: "outboxLimit", default: 1000, maximum: 1000, configured: 100 },
] as const;

for (const { option, environment, field, default: defaultValue, maximum, configured } of POLICY_OPTIONS) {
  test(`${option} uses its configured default and CLI overrides the environment within application resource limits`, () => {
    assert.equal(parseGatewayCli([], {})[field], defaultValue);
    assert.equal(parseGatewayCli([], { [environment]: String(configured) })[field], configured);
    assert.equal(parseGatewayCli([`--${option}`, "1"], { [environment]: String(configured) })[field], 1);
    assert.equal(parseGatewayCli([`--${option}`, String(configured)], { [environment]: "invalid" })[field], configured);
    assert.equal(parseGatewayCli([`--${option}`, String(maximum)], {})[field], maximum);
    assert.equal(parseGatewayCli([], { [environment]: String(maximum) })[field], maximum);
    assert.ok(getHelpText().includes(`--${option}`));
    assert.ok(getHelpText().includes(environment));
  });

  test(`${option} rejects invalid safe integers and values above its application resource limit`, () => {
    const invalid = ["", "0", "-1", "1.5", "NaN", "Infinity", "-Infinity", String(Number.MAX_SAFE_INTEGER + 1), String(maximum + 1)];
    for (const value of invalid) {
      const expected = new RegExp(`Invalid context policy ${field}`);
      assert.throws(() => parseGatewayCli([`--${option}=${value}`], {}), expected, `CLI accepted ${JSON.stringify(value)}`);
      assert.throws(() => parseGatewayCli([], { [environment]: value }), expected, `environment accepted ${JSON.stringify(value)}`);
    }
  });
}
test("Codex mode validates its selection and keeps credentials out of parsed options", () => {
  const options = parseGatewayCli(["--run", "--leader-mode", "codex", "--leader-root", "/tmp/agent-memory", "--leader-model", "gpt-6.1-sol"], {
    GATEWAY_LEADER_API_KEY: "must-not-be-in-options",
  });
  assert.equal(options.leaderMode, "codex");
  assert.equal(options.leaderRoot, "/tmp/agent-memory");
  assert.equal(options.leaderModel, "gpt-6.1-sol");
  assert.ok(!JSON.stringify(options).includes("must-not-be-in-options"));
  assert.throws(() => parseGatewayCli(["--leader-mode", "typo"], {}), /Invalid leader-mode/);
  assert.throws(() => parseGatewayCli(["--leader-model", " "], {}), /Invalid leader-model/);
  assert.equal(parseGatewayCli([], { GATEWAY_LEADER_MODE: "codex" }).leaderMode, "codex");
});


test("result attachments use an explicit configurable application budget", () => {
  assert.equal(parseGatewayCli([], {}).resultFileMaxBytes, 50 * 1024 * 1024);
  assert.equal(parseGatewayCli(["--result-file-max-bytes", "1"], {}).resultFileMaxBytes, 1);
  assert.equal(parseGatewayCli([], { RESULT_FILE_MAX_BYTES: "536870912" }).resultFileMaxBytes, 512 * 1024 * 1024);
  assert.equal(parseGatewayCli([], { RESULT_FILE_MAX_BYTES: "1024", CONSOLE_PUBLIC_URL: "https://results.example" }).resultFileMaxBytes, 1024);
  const opts = parseGatewayCli(["--result-file-max-bytes", "2048", "--result-public-origin", "https://override.example"], {
    RESULT_FILE_MAX_BYTES: "invalid", CONSOLE_PUBLIC_URL: "https://results.example",
  });
  assert.equal(opts.resultFileMaxBytes, 2048);
  assert.equal(opts.resultPublicOrigin, "https://override.example");
  for (const value of ["0", "-1", "1.5", "536870913", "invalid"]) {
    assert.throws(() => parseGatewayCli([`--result-file-max-bytes=${value}`], {}), /Invalid result-file-max-bytes/);
  }
});
