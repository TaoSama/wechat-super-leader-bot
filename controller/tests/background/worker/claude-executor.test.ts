import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { ClaudeCliExecutor, CodexWorkerRuntime, type WorkerInput, type WorkerRuntimeStatus } from "../../../src/background/worker/index.js";

// Process contract checks include interpreter startup and durable filesystem I/O.
const CLI_EXECUTION_TIMEOUT_MS = 10_000;
const CLI_CLEANUP_MARGIN_MS = 5_000;
const CLI_TEST_TIMEOUT_MS = 2 * (CLI_EXECUTION_TIMEOUT_MS + CLI_CLEANUP_MARGIN_MS);
const STATUS_POLL_INTERVAL_MS = 10;
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const API_KEY = "sk-ant-test-secret";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

async function wait(runtime: CodexWorkerRuntime, input: WorkerInput): Promise<WorkerRuntimeStatus> {
  const deadline = performance.now() + CLI_EXECUTION_TIMEOUT_MS + CLI_CLEANUP_MARGIN_MS;
  while (performance.now() < deadline) {
    const status = await runtime.inspect(input.workerId, input.invocationId);
    if (!["running", "queued"].includes(status.status)) return status;
    await new Promise(resolve => setTimeout(resolve, STATUS_POLL_INTERVAL_MS));
  }
  throw new Error("Child process did not stop within test budget");
}

function fixture(mode = "complete", timeoutMs = CLI_EXECUTION_TIMEOUT_MS, consoleModel = "gpt-ignored",
  credential: { apiKey?: string; authToken?: string; baseUrl?: string } = { apiKey: API_KEY }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-worker-test-")); roots.push(root);
  const script = path.join(root, "claude");
  fs.writeFileSync(script, `#!${process.execPath}
const fs = require('node:fs');
const mode = ${JSON.stringify(mode)};
const args = process.argv.slice(2);
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
 fs.writeFileSync('observed.json', JSON.stringify({args, input, home: process.env.HOME, configDir: process.env.CLAUDE_CONFIG_DIR,
   apiKey: process.env.ANTHROPIC_API_KEY, oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN, scrub: process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB,
   unexpected: process.env.WORKER_TEST_SECRET, tmp: process.env.CLAUDE_CODE_TMPDIR, tmpdir: process.env.TMPDIR, baseUrl: process.env.ANTHROPIC_BASE_URL,
   authToken: process.env.ANTHROPIC_AUTH_TOKEN}));
 process.stderr.write('provider said: ' + process.env.ANTHROPIC_API_KEY + '\\n');
 if (mode === 'hang') { setInterval(() => {}, 1000); return; }
 const emit = event => console.log(JSON.stringify({ session_id: '${SESSION_ID}', ...event }));
 emit({ type: 'system', subtype: 'init' });
 if (mode === 'crash') process.exit(3);
 const output = { status: 'completed', summary: 'Claude 执行成功', nextCheckAt: null, attachments: [] };
 const result = { type: 'result', subtype: 'success', is_error: false, result: 'done', permission_denials: [] };
 if (mode === 'invalid') emit({ ...result, structured_output: { ...output, status: 'bogus' } });
 else if (mode === 'missing') emit(result);
 else if (mode === 'error') { emit({ ...result, subtype: 'error_during_execution', is_error: true, result: process.env.ANTHROPIC_API_KEY }); process.exit(1); }
 else emit({ ...result, structured_output: output });
});
`, { mode: 0o700 });
  const errors: Error[] = [];
  const options = { root: path.join(root, "runtime"), artifactRoot: path.join(root, "artifacts"), model: "claude-cli-default", timeoutMs,
    onError: (error: Error) => { errors.push(error); } };
  const executor = new ClaudeCliExecutor({ artifactRoot: options.artifactRoot, privateRoots: [options.root], claudePath: script,
    model: "sonnet", ...credential });
  const input = { workerId: randomUUID(), invocationId: randomUUID(), task: "Check sources without writing", input: { status: "running" } };
  const runtime = new CodexWorkerRuntime({ ...options, executor,
    runtimeSettings: () => ({ model: consoleModel, reasoningEffort: "high", systemPrompt: "Claude后台SP" }) });
  const workspace = path.join(options.root, "workers", input.workerId, "workspace");
  const observed = () => JSON.parse(fs.readFileSync(path.join(workspace, "observed.json"), "utf8"));
  const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];
  return { root, options, input, runtime, workspace, observed, flag, errors };
}

describe("Claude CLI process contract", () => {
  it("requires exactly one credential", () => {
    expect(() => new ClaudeCliExecutor({ artifactRoot: "/data/artifacts" })).toThrow(/credential/);
    expect(() => new ClaudeCliExecutor({ artifactRoot: "/data/artifacts", apiKey: "a", authToken: "b" })).toThrow(/exactly one/);
  });
  it("sends a gateway bearer token to the configured Anthropic-compatible endpoint", async () => {
    const f = fixture("complete", CLI_EXECUTION_TIMEOUT_MS, "gpt-ignored", { authToken: API_KEY, baseUrl: "https://gateway.test" });
    await f.runtime.start(f.input);
    expect((await wait(f.runtime, f.input)).status).toBe("completed");
    expect(f.observed()).toMatchObject({ authToken: API_KEY, baseUrl: "https://gateway.test" });
    expect(f.observed().apiKey).toBeUndefined();
  }, CLI_TEST_TIMEOUT_MS);
  it("accepts schema-valid structured output, records the session and resumes it", async () => {
    process.env.WORKER_TEST_SECRET = "must-not-inherit";
    const f = fixture();
    try {
      await f.runtime.start(f.input);
      const status = await wait(f.runtime, f.input);
      expect(status).toMatchObject({ status: "completed", summary: "Claude 执行成功", threadId: SESSION_ID });
      let seen = f.observed();
      expect(seen.args).not.toContain("--resume");
      expect(seen.input).toContain("Claude后台SP");
      expect(seen.args.slice(0, 4)).toEqual(["-p", "--verbose", "--output-format", "stream-json"]);
      expect(JSON.parse(f.flag(seen.args, "--json-schema")).required).toEqual(["status", "summary", "nextCheckAt", "attachments"]);
      expect(f.flag(seen.args, "--permission-mode")).toBe("dontAsk");
      expect(f.flag(seen.args, "--model")).toBe("sonnet");
      expect(f.flag(seen.args, "--effort")).toBe("high");
      expect(f.flag(seen.args, "--setting-sources")).toBe("user");
      expect(f.flag(seen.args, "--tools")).toBe("Bash,Read,Edit,Write,Glob,Grep,WebFetch,WebSearch");
      expect(seen.args).toContain("--strict-mcp-config");
      expect(seen.args).not.toContain("--dangerously-skip-permissions");
      const canonicalWorkspace = fs.realpathSync(f.workspace);
      expect(seen.home).toBe(canonicalWorkspace);
      expect(seen.configDir).toBe(path.join(path.dirname(canonicalWorkspace), "home"));
      expect(seen).toMatchObject({ apiKey: API_KEY, scrub: "1" });
      expect(seen.oauth).toBeUndefined();
      expect(seen.unexpected).toBeUndefined();

      const next = { ...f.input, invocationId: randomUUID() };
      await f.runtime.start(next);
      expect((await wait(f.runtime, next)).status).toBe("completed");
      seen = f.observed();
      expect(f.flag(seen.args, "--resume")).toBe(SESSION_ID);
    } finally { delete process.env.WORKER_TEST_SECRET; }
  }, CLI_TEST_TIMEOUT_MS);
  it("passes sandboxed settings that confine writes to the workspace and deny protected roots", async () => {
    const f = fixture();
    await f.runtime.start(f.input);
    await wait(f.runtime, f.input);
    const args = f.observed().args;
    const settings = JSON.parse(f.flag(args, "--settings"));
    const canonicalWorkspace = fs.realpathSync(f.workspace);
    const home = path.join(path.dirname(canonicalWorkspace), "home");
    const temp = settings.sandbox.filesystem.allowRead[1];
    expect(settings.sandbox).toEqual({ enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false, enableWeakerNestedSandbox: false,
      network: { allowedDomains: ["*"], deniedDomains: ["postgres", "controller", "gateway", "169.254.169.254", "metadata.google.internal"] },
      // Every shared temp entry stays closed; only this worker's turn-scoped temp directory is reopened.
      filesystem: { denyRead: [f.options.artifactRoot, f.options.root, path.join(os.tmpdir(), "*")], allowRead: [canonicalWorkspace, temp],
        allowWrite: [temp] } });
    expect(temp).toBe(path.join(os.tmpdir(), `slc-${path.basename(path.dirname(canonicalWorkspace)).slice(0, 12)}`));
    // Longer paths make the CLI hand sandboxed Bash the shared temp root instead.
    if (os.tmpdir() === "/tmp") expect(Buffer.byteLength(path.join(temp, "claude-1000"))).toBeLessThanOrEqual(44);
    expect(f.observed()).toMatchObject({ tmp: temp, tmpdir: temp });
    // The turn-scoped temp directory is removed after the CLI exits.
    expect(fs.existsSync(temp)).toBe(false);
    expect(settings.disableAllHooks).toBe(true);
    expect(settings.permissions.allow).toEqual(["Bash", "WebFetch", "WebSearch",
      `Read(/${canonicalWorkspace}/**)`, `Edit(/${canonicalWorkspace}/**)`]);
    // Unscoped file tools would read sibling workers and controller state.
    for (const tool of ["Read", "Glob", "Grep", "Edit", "Write"]) expect(settings.permissions.allow).not.toContain(tool);
    for (const root of [home, f.options.artifactRoot, "/etc/super-leader", "/proc"]) {
      expect(settings.permissions.deny).toEqual(expect.arrayContaining([`Read(/${root}/**)`, `Edit(/${root}/**)`]));
    }
    expect(f.flag(args, "--allowedTools")).toBe(settings.permissions.allow.join(","));
  }, CLI_TEST_TIMEOUT_MS);
  it.each([["opus", "opus"], ["claude-opus-4-1", "claude-opus-4-1"], ["claude-cli-default", "sonnet"], ["gpt-5.5", "sonnet"]])(
    "uses the console model %s only when it names a Claude model", async (consoleModel, expected) => {
      const f = fixture("complete", CLI_EXECUTION_TIMEOUT_MS, consoleModel);
      await f.runtime.start(f.input);
      await wait(f.runtime, f.input);
      expect(f.flag(f.observed().args, "--model")).toBe(expected);
    }, CLI_TEST_TIMEOUT_MS);
  it.each(["invalid", "missing", "error", "crash"])("does not accept an unverified Claude result (%s)", async mode => {
    const f = fixture(mode);
    await f.runtime.start(f.input);
    const status = await wait(f.runtime, f.input);
    expect(status).toMatchObject({ status: "needs_attention", error: "worker_execution_unverified" });
    const persisted = fs.readdirSync(path.dirname(f.workspace)).filter(file => file.endsWith(".json"))
      .map(file => fs.readFileSync(path.join(path.dirname(f.workspace), file), "utf8")).join("\n");
    const reported = f.errors.map(error => `${error.message} ${String((error.cause as Error | undefined)?.message)}`).join("\n");
    for (const text of [JSON.stringify(status), persisted, reported]) expect(text).not.toContain(API_KEY);
  }, CLI_TEST_TIMEOUT_MS);
  it("terminates and reaps a hung Claude process after its budget", async () => {
    const f = fixture("hang", 50);
    await f.runtime.start(f.input);
    expect(await wait(f.runtime, f.input)).toMatchObject({ status: "needs_attention", error: "worker_interrupted" });
    await f.runtime.exportArtifacts(f.input.workerId, f.input.invocationId);
    await f.runtime.cleanup(f.input.workerId);
    expect(fs.existsSync(f.workspace)).toBe(false);
  }, CLI_TEST_TIMEOUT_MS);
  it("stops on cancellation without accepting a result", async () => {
    const f = fixture("hang");
    await f.runtime.start(f.input);
    for (let attempt = 0; attempt < 500 && !fs.existsSync(path.join(f.workspace, "observed.json")); attempt++) {
      await new Promise(resolve => setTimeout(resolve, STATUS_POLL_INTERVAL_MS));
    }
    await f.runtime.cancel(f.input.workerId, f.input.invocationId);
    expect((await wait(f.runtime, f.input)).status).not.toBe("completed");
  }, CLI_TEST_TIMEOUT_MS);
});
