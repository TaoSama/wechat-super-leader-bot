import { spawn } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import * as path from "node:path";
import type { WorkerExecutionRequest, WorkerExecutor, WorkerRuntimeOptions } from "./contracts.js";

const MAX_STREAM_BYTES = 16 * 1024 * 1024;
const KILL_GRACE_MS = 3000;
const HARD_STOP_MS = KILL_GRACE_MS + 1000;
const ENV_ALLOWLIST = ["PATH", "LANG", "LC_ALL", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"] as const;

export class WorkerExecutionFailure extends Error {
  constructor(message: string, readonly processCleanupUnverified = false) { super(message); }
}

function executable(command: string): string {
  const candidates = command.includes(path.sep) ? [command]
    : (process.env.PATH ?? "").split(path.delimiter).map(dir => path.join(dir, command));
  for (const candidate of candidates) {
    try { accessSync(candidate, constants.X_OK); return realpathSync(candidate); }
    catch (error) {
      if (!["ENOENT", "EACCES", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  throw new Error("Configured Codex executable is unavailable");
}

export class CodexCliExecutor implements WorkerExecutor {
  constructor(private readonly options: WorkerRuntimeOptions) {}

  async execute(request: WorkerExecutionRequest): Promise<string> {
    if (request.signal.aborted) throw new Error("Worker execution cancelled before launch");
    const command = executable(this.options.codexPath ?? "codex");
    const nodePath = realpathSync(process.execPath);
    const shellPath = [path.dirname(nodePath), "/usr/local/bin", "/usr/bin", "/bin"].join(path.delimiter);
    const nodeLibraries = process.platform === "darwin"
      ? [...new Set(((process.report.getReport() as { sharedObjects?: string[] }).sharedObjects ?? [])
        .filter(file => file.startsWith("/opt/homebrew/Cellar/") && file.endsWith(".dylib"))
        .flatMap(file => [path.dirname(file), "/opt/homebrew/opt"]))]
      : [];
    const workerDir = path.dirname(request.workspace);
    // The runtime package is readable; other worker homes, controller files and
    // process environments are outside this worker's filesystem capability.
    const filesystem = [[":minimal", "read"], [this.options.root, "deny"], [this.options.artifactRoot, "deny"],
      [workerDir, "deny"], [request.workspace, "write"],
      [request.home, "deny"], ["/etc/super-leader", "deny"], ["/proc", "deny"],
      [path.resolve(path.dirname(command), ".."), "read"],
      [path.resolve(path.dirname(nodePath), ".."), "read"], ...nodeLibraries.map(file => [file, "read"])]
      .map(([file, access]) => `${JSON.stringify(file)}=${JSON.stringify(access)}`).join(",");
    const config = [
      `permissions.background_worker={filesystem={${filesystem}},network={enabled=true}}`,
      'default_permissions="background_worker"', 'approval_policy="never"',
      'shell_environment_policy.inherit="none"',
      'features.multi_agent=false', 'features.multi_agent_v2=false', 'features.goals=false', 'features.hooks=false',
      `shell_environment_policy.set=${JSON.stringify({ PATH: shellPath, HOME: request.workspace,
        ...(process.platform === "darwin" ? { OPENSSL_CONF: "/dev/null" } : {}) })
        .replace(/"([^"\\]+)":/g, '"$1"=')}`,
      'shell_environment_policy.exclude=["CODEX_API_KEY","OPENAI_API_KEY"]',
    ];
    if (this.options.baseUrl) config.push('model_provider="background_api"',
      `model_providers.background_api={name="Background API",base_url=${JSON.stringify(this.options.baseUrl)},env_key="CODEX_API_KEY",wire_api="responses"}`);
    const args = ["exec", "--json", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check",
      "--model", this.options.model, "--output-schema", request.schemaPath,
      ...config.flatMap(value => ["--config", value]),
      ...(request.threadId ? ["resume", request.threadId] : []), "-"];
    const env: NodeJS.ProcessEnv = { HOME: request.workspace, CODEX_HOME: request.home };
    for (const key of ENV_ALLOWLIST) if (process.env[key] !== undefined) env[key] = process.env[key];
    if (this.options.apiKey) env.CODEX_API_KEY = this.options.apiKey;
    return new Promise<string>((resolve, reject) => {
      const child = spawn(command, args, { cwd: request.workspace, env, detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"] });
      let remaining = "";
      let bytes = 0;
      let output = "";
      let completed = false;
      let failure: Error | undefined;
      let callbacks = Promise.resolve();
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let hardTimer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const kill = (signal: NodeJS.Signals) => {
        if (!child.pid) return;
        try { process.kill(process.platform === "win32" ? child.pid : -child.pid, signal); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure = new Error("Unable to stop worker process"); }
      };
      const stop = () => {
        kill("SIGTERM");
        killTimer ??= setTimeout(() => kill("SIGKILL"), KILL_GRACE_MS);
        hardTimer ??= setTimeout(() => {
          if (settled) return;
          settled = true;
          request.signal.removeEventListener("abort", stop);
          child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
          reject(new WorkerExecutionFailure("Worker descendants could not be confirmed stopped", true));
        }, HARD_STOP_MS);
      };
      const fail = (message: string) => { failure ??= new Error(message); stop(); };
      const line = (raw: string) => {
        if (!raw.trim()) return;
        try {
          const event = JSON.parse(raw) as Record<string, any>;
          if (event.type === "thread.started") callbacks = callbacks.then(() => request.onThread(event.thread_id))
            .catch(() => fail("Unable to persist worker thread identity"));
          if (event.type === "item.completed" && event.item?.type === "agent_message") output = event.item.text;
          if (event.type === "turn.completed") completed = true;
          if (event.type === "turn.failed" || event.type === "error") fail("Codex reported a failed worker turn");
        } catch { fail("Codex emitted an invalid event"); }
      };
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_STREAM_BYTES) { fail("Worker output exceeded its budget"); return; }
        remaining += chunk;
        let boundary: number;
        while ((boundary = remaining.indexOf("\n")) >= 0) {
          line(remaining.slice(0, boundary)); remaining = remaining.slice(boundary + 1);
        }
      });
      child.stderr.on("data", () => { /* Drain diagnostics; never propagate secrets from provider errors. */ });
      child.stdin.on("error", () => fail("Codex closed its input unexpectedly"));
      child.once("error", () => fail("Codex worker process could not start"));
      child.once("exit", stop);
      child.once("close", async code => {
        request.signal.removeEventListener("abort", stop);
        if (killTimer) clearTimeout(killTimer);
        if (hardTimer) clearTimeout(hardTimer);
        if (settled) return;
        settled = true;
        // A completed turn must not leave ordinary shell descendants running in
        // its process group after the workspace becomes eligible for cleanup.
        kill("SIGKILL");
        line(remaining);
        try {
          await callbacks;
          if (request.signal.aborted) throw new Error("Worker execution interrupted; effects must be checked before retrying");
          if (failure) throw failure;
          if (code !== 0 || !completed || !output.trim()) throw new Error("Worker ended without a verified complete turn");
          resolve(output);
        } catch (error) { reject(error); }
      });
      request.signal.addEventListener("abort", stop, { once: true });
      if (request.signal.aborted) stop();
      if (child.pid) request.onProcess(child.pid).then(() => child.stdin.end(request.prompt), () => fail("Unable to persist worker launch receipt"));
    });
  }
}
