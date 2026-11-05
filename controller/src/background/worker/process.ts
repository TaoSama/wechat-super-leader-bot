import { spawn } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import * as path from "node:path";
import type { WorkerExecutionRequest } from "./contracts.js";

const MAX_STREAM_BYTES = 16 * 1024 * 1024;
const KILL_GRACE_MS = 3000;
const HARD_STOP_MS = KILL_GRACE_MS + 1000;
const ENV_ALLOWLIST = ["PATH", "LANG", "LC_ALL", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"] as const;

export class WorkerExecutionFailure extends Error {
  constructor(message: string, readonly processCleanupUnverified = false) { super(message); }
}

/** Resolves a CLI to its canonical path; `label` names the CLI in the error message. */
export function executable(command: string, label: string): string {
  const candidates = command.includes(path.sep) ? [command]
    : (process.env.PATH ?? "").split(path.delimiter).map(dir => path.join(dir, command));
  for (const candidate of candidates) {
    try { accessSync(candidate, constants.X_OK); return realpathSync(candidate); }
    catch (error) {
      if (!["ENOENT", "EACCES", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  throw new Error(`Configured ${label} executable is unavailable`);
}

/** Child environment limited to the allowlist plus explicit worker values. */
export function workerEnvironment(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...extra };
  for (const key of ENV_ALLOWLIST) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}

export interface WorkerEventContext {
  fail(message: string): void;
  /** Persists the CLI's resumable session identity before the turn is accepted. */
  thread(threadId: string): void;
}

export interface WorkerProcessSpec {
  /** CLI name used in diagnostics that never include provider output. */
  label: string;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  onEvent(event: Record<string, any>, context: WorkerEventContext): void;
  /** Returns the verified result text or throws when the turn is not provably complete. */
  finish(code: number | null): string;
}

/**
 * Runs one JSONL-streaming worker turn in its own process group with a stream
 * budget, graceful then forced termination and a bounded hard stop.
 */
export function runWorkerProcess(request: WorkerExecutionRequest, spec: WorkerProcessSpec): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(spec.command, spec.args, { cwd: request.workspace, env: spec.env,
      detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    let remaining = "";
    let bytes = 0;
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
    const context: WorkerEventContext = {
      fail,
      thread: threadId => {
        callbacks = callbacks.then(() => request.onThread(threadId))
          .catch(() => fail("Unable to persist worker thread identity"));
      },
    };
    const line = (raw: string) => {
      if (!raw.trim()) return;
      let event: Record<string, any>;
      try { event = JSON.parse(raw) as Record<string, any>; }
      catch { fail(`${spec.label} emitted an invalid event`); return; }
      try { spec.onEvent(event, context); }
      catch { fail(`${spec.label} emitted an invalid event`); }
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
    child.stdin.on("error", () => fail(`${spec.label} closed its input unexpectedly`));
    child.once("error", () => fail(`${spec.label} worker process could not start`));
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
        resolve(spec.finish(code));
      } catch (error) { reject(error); }
    });
    request.signal.addEventListener("abort", stop, { once: true });
    if (request.signal.aborted) stop();
    if (child.pid) request.onProcess(child.pid).then(() => child.stdin.end(request.prompt), () => fail("Unable to persist worker launch receipt"));
  });
}
