import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { CodexWorkerRuntime, type WorkerInput, type WorkerRuntimeStatus } from "../../../src/background/worker/index.js";

// Process contract checks include interpreter startup and durable filesystem I/O.
const CLI_EXECUTION_TIMEOUT_MS = 10_000;
const CLI_CLEANUP_MARGIN_MS = 5_000;
const CLI_TEST_TIMEOUT_MS = 2 * (CLI_EXECUTION_TIMEOUT_MS + CLI_CLEANUP_MARGIN_MS);
const STATUS_POLL_INTERVAL_MS = 10;
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
function fixture(mode = "complete", timeoutMs = CLI_EXECUTION_TIMEOUT_MS) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-child-test-")); roots.push(root);
  const script = path.join(root, "codex");
  fs.writeFileSync(script, `#!${process.execPath}
const fs = require('node:fs');
const mode = ${JSON.stringify(mode)};
const args = process.argv.slice(2);
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
 fs.writeFileSync('observed.json', JSON.stringify({args,home:process.env.HOME,codexHome:process.env.CODEX_HOME, unexpected:process.env.WORKER_TEST_SECRET,input}));
 if (mode === 'hang') { setInterval(() => {}, 1000); return; }
 if (mode === 'escape') { const {spawn}=require('node:child_process'); const escaped=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'inherit'});fs.writeFileSync('escaped.pid',String(escaped.pid));setInterval(()=>{},1000);return; }
 console.log(JSON.stringify({type:'thread.started',thread_id:'11111111-1111-4111-8111-111111111111'}));
 if (mode === 'fail') { console.log(JSON.stringify({type:'turn.failed',error:{message:'secret-provider-key'}})); return; }
 if (mode === 'garbage') { console.log('invalid JSON'); return; }
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({status:'completed',summary:'两轮执行成功',nextCheckAt:null,attachments:[]})}}));
 if (mode !== 'incomplete') console.log(JSON.stringify({type:'turn.completed'}));
});
`, { mode: 0o700 });
  const options = { root: path.join(root, "runtime"), artifactRoot: path.join(root, "artifacts"), codexPath: script,
    model: "test", baseUrl: "https://worker-provider.example.test/v1", apiKey: "provider-secret", timeoutMs };
  const input = { workerId: randomUUID(), invocationId: randomUUID(), task: "Check sources without writing", input: { status: "running" } };
  return { root, options, input, runtime: new CodexWorkerRuntime(options), workspace: path.join(options.root, "workers", input.workerId, "workspace") };
}

describe("Codex CLI process contract", () => {
  it("uses explicit persistent resume IDs, schema, isolated home and permissions with no inherited controller secrets", async () => {
    process.env.WORKER_TEST_SECRET = "must-not-inherit";
    const f = fixture();
    try {
      await f.runtime.start(f.input);
      expect((await wait(f.runtime, f.input)).summary).toBe("两轮执行成功");
      const next = { ...f.input, invocationId: randomUUID() };
      await f.runtime.start(next); expect((await wait(f.runtime, next)).status).toBe("completed");
      const observed = JSON.parse(fs.readFileSync(path.join(f.workspace, "observed.json"), "utf8"));
      expect(observed.args).toContain("resume");
      expect(observed.args).toContain("11111111-1111-4111-8111-111111111111");
      expect(observed.args).toContain("--output-schema");
      expect(observed.args).toContain("--ignore-user-config");
      expect(observed.args).not.toContain("--ephemeral");
      expect(observed.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
      expect(observed.args.join(" ")).toContain('shell_environment_policy.inherit="none"');
      expect(observed.args).toContain('web_search="live"');
      expect(observed.args).toContain('skills.bundled.enabled=false');
      expect(observed.args.find((value: string) => value.startsWith('model_providers.background_api=')))
        .toContain('supports_standalone_web_search=true');
      expect(observed.args.find((value: string) => value.startsWith('mcp_servers.openaiDeveloperDocs=')))
        .toContain('url="https://developers.openai.com/mcp",required=false');
      for (const feature of ["shell_tool", "unified_exec", "shell_snapshot", "skill_search", "view_image", "sleep_tool"]) {
        expect(observed.args).toContain(`features.${feature}=true`);
      }
      for (const feature of ["multi_agent", "multi_agent_v2", "goals", "hooks", "browser_use", "browser_use_external",
        "browser_use_full_cdp_access", "browser_annotation_api", "in_app_browser", "in_app_local_automation", "computer_use"]) {
        expect(observed.args).toContain(`features.${feature}=false`);
      }
      expect(observed.args.join(" ")).toContain('network={enabled=true}');
      expect(observed.args.join(" ")).toContain('"/proc"="deny"');
      const profile = observed.args.find((value: string) => value.startsWith('permissions.background_worker='));
      expect(profile).toContain('\":minimal\"=\"read\"');
      expect(profile).toContain('\"/etc/codex/skills\"=\"read\"');
      const canonicalWorkspace = fs.realpathSync(f.workspace);
      expect(profile).toContain(`${JSON.stringify(canonicalWorkspace)}=\"write\"`);
      expect(profile).toContain(`${JSON.stringify(path.join(path.dirname(canonicalWorkspace), "home"))}=\"deny\"`);
      expect(profile).not.toContain(`${JSON.stringify(fs.realpathSync(f.options.root))}=\"deny\"`);
      expect(profile).not.toContain(`${JSON.stringify(path.dirname(canonicalWorkspace))}=\"deny\"`);
      expect(observed.home).toBe(observed.codexHome.replace(/home$/, "workspace"));
      expect(observed.unexpected).toBeUndefined();
    } finally { delete process.env.WORKER_TEST_SECRET; }
  }, CLI_TEST_TIMEOUT_MS);
  it.each(["fail", "garbage", "incomplete"])("does not accept an unverified CLI completion (%s)", async mode => {
    const f = fixture(mode);
    await f.runtime.start(f.input);
    const status = await wait(f.runtime, f.input);
    expect(status).toMatchObject({ status: "needs_attention", error: "worker_execution_unverified" });
    expect(JSON.stringify(status)).not.toContain("secret-provider-key");
    expect((await f.runtime.start(f.input)).status).toBe("needs_attention");
  }, CLI_TEST_TIMEOUT_MS);
  it("terminates and reaps a real child process after its budget", async () => {
    const f = fixture("hang", 50);
    await f.runtime.start(f.input);
    expect((await wait(f.runtime, f.input)).status).toBe("needs_attention");
    await f.runtime.exportArtifacts(f.input.workerId, f.input.invocationId);
    await f.runtime.cleanup(f.input.workerId);
    expect(fs.existsSync(f.workspace)).toBe(false);
  }, CLI_TEST_TIMEOUT_MS);
  it("records a launch failure without exposing raw provider diagnostics", async () => {
    const f = fixture();
    fs.unlinkSync(f.options.codexPath);
    await f.runtime.start(f.input);
    expect(await wait(f.runtime, f.input)).toMatchObject({ status: "needs_attention", error: "worker_execution_unverified" });
  }, CLI_TEST_TIMEOUT_MS);
  it("bounds shutdown when an escaped descendant holds pipes and quarantines its worker and capacity", async () => {
    const f = fixture("escape", 20000);
    await f.runtime.start(f.input);
    const pidFile = path.join(f.workspace, "escaped.pid");
    let escapedPid: number | undefined;
    try {
      for (let attempt = 0; attempt < 200 && !fs.existsSync(pidFile); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
      escapedPid = Number(fs.readFileSync(pidFile, "utf8"));
      const started = Date.now();
      await f.runtime.shutdown();
      expect(Date.now() - started).toBeLessThan(5500);
      const status = await f.runtime.inspect(f.input.workerId, f.input.invocationId);
      expect(status).toMatchObject({ status: "needs_attention", error: "worker_process_cleanup_unverified" });
      await expect(f.runtime.exportArtifacts(f.input.workerId, f.input.invocationId)).rejects.toThrow("unverified");
      await expect(f.runtime.cleanup(f.input.workerId)).rejects.toThrow();
      const slot = JSON.parse(fs.readFileSync(path.join(f.options.root, "slots", "0.json"), "utf8"));
      expect(slot.cleanupUnverified).toBe(true);
      expect(fs.existsSync(path.join(f.options.root, "workers", f.input.workerId, "active.json"))).toBe(true);
    } finally {
      if (escapedPid) {
        try { process.kill(-escapedPid, "SIGKILL"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
    }
  }, 10000);

});
