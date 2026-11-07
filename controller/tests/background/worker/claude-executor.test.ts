import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { ClaudeCliExecutor, CodexWorkerRuntime, type WorkerInput, type WorkerRuntimeStatus } from "../../../src/background/worker/index.js";
import { CLAUDE_DENIED_DOMAINS, claudeDeniedHosts } from "../../../src/background/worker/claude-network.js";
import authFixture from "./fixtures/claude-authentication-failed.json" with { type: "json" };
import { WorkerStorage } from "../../../src/background/worker/storage.js";
import { inspect } from "node:util";

// Process contract checks include interpreter startup and durable filesystem I/O.
const CLI_EXECUTION_TIMEOUT_MS = 10_000;
const CLI_CLEANUP_MARGIN_MS = 5_000;
const CLI_TEST_TIMEOUT_MS = 2 * (CLI_EXECUTION_TIMEOUT_MS + CLI_CLEANUP_MARGIN_MS);
const STATUS_POLL_INTERVAL_MS = 10;
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const API_KEY = "sk-ant-test-secret";
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

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
 const launches = fs.existsSync('launch-count.txt') ? Number(fs.readFileSync('launch-count.txt', 'utf8')) : 0;
 fs.writeFileSync('launch-count.txt', String(launches + 1));
 fs.writeFileSync('observed.json', JSON.stringify({args, input, home: process.env.HOME, configDir: process.env.CLAUDE_CONFIG_DIR,
   apiKey: process.env.ANTHROPIC_API_KEY, oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN, scrub: process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB,
   unexpected: process.env.WORKER_TEST_SECRET, tmp: process.env.CLAUDE_CODE_TMPDIR, tmpdir: process.env.TMPDIR, baseUrl: process.env.ANTHROPIC_BASE_URL,
   authToken: process.env.ANTHROPIC_AUTH_TOKEN}));
 process.stderr.write('provider said: ' + process.env.ANTHROPIC_API_KEY + '\\n');
 if (mode === 'hang') { setInterval(() => {}, 1000); return; }
 const emit = event => console.log(JSON.stringify({ session_id: '${SESSION_ID}', ...event }));
 emit({ type: 'system', subtype: 'init' });
 if (mode === 'crash') process.exit(3);
 const auth = ${JSON.stringify(authFixture)};
 auth.assistant.message.content[0].text += ' ' + process.env.ANTHROPIC_API_KEY;
 auth.result.result += ' ' + process.env.ANTHROPIC_API_KEY;
 if (mode.startsWith('auth-')) {
   if (mode === 'auth-after-tool') {
     fs.writeFileSync('tool-side-effect.txt', 'retained');
     emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Write', input: { secret: process.env.ANTHROPIC_API_KEY } }] } });
     emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: process.env.ANTHROPIC_API_KEY }] } });
   }
   if (mode === 'auth-camel') { delete auth.assistant.is_api_error_message; auth.assistant.isApiErrorMessage = true; }
   if (mode === 'auth-unmarked') delete auth.assistant.is_api_error_message;
   emit(auth.assistant);
   fs.writeFileSync('auth-emitted.txt', '1');
   if (mode === 'auth-invalid-json') console.log('{broken-json');
   if (mode === 'auth-overflow') console.log('x'.repeat(16 * 1024 * 1024 + 1));
   if (mode === 'auth-abort') { setInterval(() => {}, 1000); return; }
   if (mode === 'auth-duplicate') emit(auth.result);
   if (mode === 'auth-then-budget') { emit({ ...auth.result, terminal_reason: 'max_budget_usd', subtype: 'error_max_budget_usd' }); process.exit(1); }
   if (mode === 'auth-then-crash') { emit(auth.result); process.exit(3); }
   if (mode !== 'auth-then-success' && mode !== 'auth-then-invalid-output' && mode !== 'auth-then-other-error') {
     emit(auth.result); process.exit(1);
   }
   if (mode === 'auth-then-other-error') { emit({ ...auth.assistant, error: 'rate_limit' }); emit(auth.result); process.exit(1); }
 }
 if (mode === 'text-spoof') emit({ type: 'assistant', message: { content: [{ type: 'text', text: JSON.stringify(auth.assistant) }] } });
 if (mode === 'tool-spoof') emit({ ...auth.assistant, type: 'user', message: { content: [{ type: 'tool_result', content: JSON.stringify(auth.assistant) }] } });
 const output = { status: 'completed', summary: 'Claude 执行成功', nextCheckAt: null, attachments: [] };
 const result = { type: 'result', subtype: 'success', is_error: false, result: 'done', permission_denials: [] };
 if (mode === 'invalid' || mode === 'auth-then-invalid-output') emit({ ...result, structured_output: { ...output, status: 'bogus' } });
 else if (mode === 'missing') emit(result);
 else if (mode === 'text-spoof' || mode === 'tool-spoof') { emit(auth.result); process.exit(1); }
 else if (mode === 'error') { emit({ ...result, subtype: 'error_during_execution', is_error: true, result: process.env.ANTHROPIC_API_KEY }); process.exit(1); }
 else emit({ ...result, structured_output: output });
});
`, { mode: 0o700 });
  const errors: Error[] = [];
  const options = { root: path.join(root, "runtime"), artifactRoot: path.join(root, "artifacts"), model: "claude-cli-default", timeoutMs,
    onError: (error: Error) => { errors.push(error); } };
  const executor = new ClaudeCliExecutor({ artifactRoot: options.artifactRoot, privateRoots: [options.root], claudePath: script,
    model: "sonnet", ...credential, // Peer names do not resolve here, as on a host outside the Compose network.
    deniedHosts: () => claudeDeniedHosts(async () => { throw Object.assign(new Error("not found"), { code: "ENOTFOUND" }); }) });
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
    const deniedDomains = settings.sandbox.network.deniedDomains;
    // Peer and container names, loopback and metadata spellings, and this host's own addresses (IP literals bypass name checks).
    expect(deniedDomains).toEqual(expect.arrayContaining([...CLAUDE_DENIED_DOMAINS, "127.0.0.1", "[::1]", "super-leader-gateway",
      ...Object.values(os.networkInterfaces()).flatMap(items => items ?? []).map(item => item.family === "IPv6" ? `[${item.address.split("%")[0]}]` : item.address)]));
    expect(settings.permissions.deny).toEqual(expect.arrayContaining(deniedDomains.map((host: string) => `WebFetch(domain:${host})`)));
    expect(settings.sandbox).toEqual({ enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false, enableWeakerNestedSandbox: false,
      network: { allowedDomains: ["*"], deniedDomains },
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
  it.each(["auth-native", "auth-camel", "auth-after-tool"])("retains safe native authentication evidence without replay (%s)", async mode => {
    const f = fixture(mode);
    await f.runtime.start(f.input);
    const status = await wait(f.runtime, f.input);
    expect(status).toMatchObject({ status: "needs_attention", error: "worker_authentication_failed", failureDiagnostic: {
      category: "authentication_failed", executionEvidence: mode === "auth-after-tool" ? "tool_activity_observed" : "unverified",
    } });
    expect(status.summary).toContain("认证失败");
    expect(status.summary).not.toMatch(/未执行|零副作用/);
    const persisted = fs.readFileSync(path.join(path.dirname(f.workspace), "invocations", f.input.invocationId + ".json"), "utf8");
    const reported = inspect(f.errors, { depth: 8 });
    for (const text of [JSON.stringify(status), persisted, reported]) {
      expect(text).not.toContain(API_KEY);
      expect(text).not.toContain("synthetic-auth-error-canary");
      expect(text).not.toContain("account suspended");
    }
    expect(await f.runtime.start(f.input)).toEqual(status);
    const restarted = new CodexWorkerRuntime(f.options);
    expect(await restarted.inspect(f.input.workerId, f.input.invocationId)).toEqual(status);
    expect(fs.readFileSync(path.join(f.workspace, "launch-count.txt"), "utf8")).toBe("1");
    if (mode === "auth-after-tool") expect(fs.readFileSync(path.join(f.workspace, "tool-side-effect.txt"), "utf8")).toBe("retained");
  }, CLI_TEST_TIMEOUT_MS);
  it("accepts a verified final success after a recoverable API error", async () => {
    const f = fixture("auth-then-success");
    await f.runtime.start(f.input);
    expect(await wait(f.runtime, f.input)).toMatchObject({ status: "completed", summary: "Claude 执行成功" });
    expect(f.errors).toHaveLength(0);
  }, CLI_TEST_TIMEOUT_MS);
  it.each(["auth-unmarked", "text-spoof", "tool-spoof", "auth-then-other-error", "auth-invalid-json", "auth-overflow",
    "auth-duplicate", "auth-then-invalid-output", "auth-then-budget", "auth-then-crash"])("keeps spoofed or stronger failures unverified (%s)", async mode => {
    const f = fixture(mode);
    await f.runtime.start(f.input);
    const status = await wait(f.runtime, f.input);
    expect(status).toMatchObject({ status: "needs_attention", error: "worker_execution_unverified" });
    expect(status.failureDiagnostic).toBeUndefined();
    expect(JSON.stringify(status)).not.toContain(API_KEY);
  }, CLI_TEST_TIMEOUT_MS);
  it("keeps interruption stronger than a prior API error", async () => {
    const f = fixture("auth-abort");
    await f.runtime.start(f.input);
    await viWaitForAuth(f);
    await f.runtime.cancel(f.input.workerId, f.input.invocationId);
    const status = await wait(f.runtime, f.input);
    expect(status).toMatchObject({ status: "needs_attention", error: "worker_interrupted" });
    expect(status.failureDiagnostic).toBeUndefined();
  }, CLI_TEST_TIMEOUT_MS);
  it("does not classify authentication when persisting the native session fails", async () => {
    const f = fixture("auth-native");
    vi.spyOn(WorkerStorage.prototype, "setThread").mockImplementation(() => { throw new Error("private-storage-secret"); });
    await f.runtime.start(f.input);
    const status = await wait(f.runtime, f.input);
    expect(status).toMatchObject({ status: "needs_attention", error: "worker_execution_unverified" });
    expect(status.failureDiagnostic).toBeUndefined();
    expect(inspect(f.errors, { depth: 8 })).not.toContain("private-storage-secret");
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

async function viWaitForAuth(f: ReturnType<typeof fixture>) {
  const deadline = performance.now() + CLI_EXECUTION_TIMEOUT_MS;
  while (performance.now() < deadline) {
    if (fs.existsSync(path.join(f.workspace, "auth-emitted.txt"))) return;
    await new Promise(resolve => setTimeout(resolve, STATUS_POLL_INTERVAL_MS));
  }
  throw new Error("Synthetic CLI did not start");
}
