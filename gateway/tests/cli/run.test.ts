import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runCli } from "../../src/cli/run.js";
import { HealthTracker } from "../../src/runtime/health.js";
import { StateManager } from "../../src/runtime/state.js";
import { CodexReplyEngine } from "../../src/leader/codex.js";
import { WeChatGateway } from "../../src/gateway.js";

const ENV = { CONTROLLER_TOKEN: "synthetic-controller-token", GATEWAY_LEADER_API_KEY: "synthetic-model-key" };
const INVALID_IDS = [
  { label: "missing", value: undefined },
  { label: "empty", value: "" },
  { label: "whitespace", value: " \t\n " },
  { label: "object", value: { id: "synthetic-account" } },
  { label: "number", value: 42 },
  { label: "array", value: ["synthetic-account"] },
  { label: "boolean", value: true },
  { label: "false boolean", value: false },
  { label: "null", value: null },
  { label: "oversized ASCII", value: "a".repeat(4097) },
  { label: "oversized UTF-8", value: "界".repeat(1366) },
];

function fixture(t: TestContext, accountId?: unknown) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "gateway-cli-account-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const credentials = path.join(directory, "account.json");
  fs.writeFileSync(credentials, JSON.stringify({ token: "synthetic-wechat-token", ...(accountId === undefined ? {} : { accountId }) }));
  let stdout = "";
  t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => { stdout += String(chunk); return true; });
  return { directory, credentials, args: ["--credentials-path", credentials, "--leader-root", path.join(directory, "leader")],
    summary: () => JSON.parse(stdout) as { ok: boolean; hasValidAccountId: boolean } };
}

for (const { label, value } of INVALID_IDS) {
  test(`Codex --check reports ${label} account identity without exposing its value`, async t => {
    const f = fixture(t, value);
    assert.equal(new StateManager(f.credentials).account?.accountId, typeof value === "string" ? value : "");
    t.mock.method(globalThis, "fetch", async () => { assert.fail("--check must not make network requests"); });
    assert.equal(await runCli([...f.args, "--check", "--leader-mode", "codex"], ENV), 1);
    assert.equal(f.summary().ok, false);
    assert.equal(f.summary().hasValidAccountId, false);
    assert.equal("accountId" in f.summary(), false);
    assert.equal(fs.existsSync(path.join(f.directory, "leader")), false);
  });

  test(`Codex startup rejects ${label} account identity before polling or loading its engine`, async t => {
    const f = fixture(t, value);
    t.mock.method(globalThis, "fetch", async () => { assert.fail("invalid Codex account must fail before network access"); });
    for (const mode of ["--run", "--poll-once", "--establish-baseline"]) {
      await assert.rejects(runCli([...f.args, mode, "--leader-mode", "codex"], ENV), {
        message: "Invalid WeChat accountId for Codex reply engine; a non-empty account ID of at most 4096 UTF-8 bytes is required",
      });
    }
    assert.equal(fs.existsSync(path.join(f.directory, "leader")), false);
  });
}

for (const accountId of ["synthetic-account", "a".repeat(4096), `${"界".repeat(1365)}a`]) {
  test(`Codex --check accepts a valid ${Buffer.byteLength(accountId, "utf8")}-byte account identity`, async t => {
    const f = fixture(t, accountId);
    t.mock.method(globalThis, "fetch", async () => { assert.fail("--check must not make network requests"); });
    assert.equal(await runCli([...f.args, "--check", "--leader-mode", "codex"], ENV), 0);
    assert.equal(f.summary().ok, true);
    assert.equal(f.summary().hasValidAccountId, true);
  });
}

test("Controller mode preserves legacy accounts without accountId during check and baseline establishment", async t => {
  const f = fixture(t);
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    requests++;
    assert.equal(new URL(String(input)).pathname, "/ilink/bot/getupdates");
    return Response.json({ ret: 0, get_updates_buf: "synthetic-baseline", msgs: [] });
  });
  assert.equal(await runCli([...f.args, "--check", "--leader-mode", "controller"], ENV), 0);
  assert.equal(f.summary().ok, true);
  assert.equal(f.summary().hasValidAccountId, false);
  assert.equal(requests, 0);
  assert.equal(await runCli([...f.args, "--establish-baseline", "--leader-mode", "controller"], ENV), 0);
  assert.equal(requests, 1);
});

test("Codex healthcheck remains independent of account credentials", async t => {
  const f = fixture(t);
  const healthPath = path.join(f.directory, "health.json");
  const tracker = new HealthTracker(healthPath);
  tracker.startRun();
  tracker.recordPollSuccess();
  fs.rmSync(path.join(f.directory, "account.json"));
  assert.equal(await runCli([...f.args, "--healthcheck", "--health-path", healthPath, "--leader-mode", "codex"], {}), 0);
});

for (const mode of ["--poll-once", "--run"]) {
  test(`Codex ${mode} drains background cleanup before returning`, async t => {
    const f = fixture(t, "synthetic-account");
    t.mock.method(globalThis, "fetch", async () => { assert.fail("Synthetic shutdown must not access the network"); });
    t.mock.method(WeChatGateway.prototype, "pollOnce", async () => ({
      polledCount: 0, processedCount: 0, skippedCount: 0, nextSyncBuf: "synthetic-cursor",
    }));
    t.mock.method(WeChatGateway.prototype, "deliverNotificationsOnce", async () => ({ accepted: 0, uncertain: 0, skipped: 0 }));
    t.mock.method(WeChatGateway.prototype, "runLoop", async () => {});
    let entered!: () => void;
    let release!: () => void;
    const stopped = new Promise<void>(resolve => { entered = resolve; });
    const cleanup = new Promise<void>(resolve => { release = resolve; });
    t.after(() => release());
    let stopCalls = 0;
    t.mock.method(CodexReplyEngine.prototype, "stop", async () => { stopCalls++; entered(); await cleanup; });
    let finished = false;
    const result = runCli([...f.args, mode, "--leader-mode", "codex"], ENV).finally(() => { finished = true; });
    await stopped;
    assert.equal(finished, false);
    release();
    assert.equal(await result, 0);
    assert.equal(stopCalls, 1);
  });
}

test("Codex poll failure still drains background work and preserves the polling error", async t => {
  const f = fixture(t, "synthetic-account");
  const error = new Error("synthetic polling failure");
  t.mock.method(WeChatGateway.prototype, "pollOnce", async () => { throw error; });
  let stopped = false;
  t.mock.method(CodexReplyEngine.prototype, "stop", async () => { stopped = true; });
  await assert.rejects(runCli([...f.args, "--poll-once", "--leader-mode", "codex"], ENV), caught => caught === error);
  assert.equal(stopped, true);
});
