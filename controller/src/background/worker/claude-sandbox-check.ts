import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { CLAUDE_FIXED_ENV, CLAUDE_SETTING_SOURCES, claudeWorkerSettings } from "./claude-executor.js";
import { executable, workerEnvironment } from "./process.js";

const run = promisify(execFile);
const CHECK_TIMEOUT_MS = 30_000;
const MAX_CHECK_OUTPUT_BYTES = 64 * 1024;
/**
 * The namespace shape Claude's sandbox needs on Linux: a user, PID and network
 * namespace without IPC isolation, plus a fresh /proc for the PID namespace.
 * Seccomp, AppArmor and Docker's masked /proc paths each reject part of it.
 */
const BWRAP_TRIAL = ["--new-session", "--die-with-parent", "--unshare-user", "--unshare-pid", "--unshare-net",
  "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--", "/bin/true"];

export interface ClaudeSandboxCheckOptions {
  claudePath?: string;
  artifactRoot: string;
  privateRoots?: string[];
  platform?: NodeJS.Platform;
}

interface SandboxStatus { enabled?: unknown; strictMode?: unknown; unavailableReason?: unknown }

function refuse(reason: string): never {
  throw new Error(`BACKGROUND_EXECUTOR=claude refused: the Claude Code sandbox is unavailable (${reason}); background tasks never run unsandboxed`);
}

/**
 * Proves at startup that the worker settings load and the OS sandbox can start,
 * so the controller fails closed instead of accepting tasks it cannot isolate.
 */
export async function verifyClaudeSandbox(options: ClaudeSandboxCheckOptions): Promise<void> {
  const claude = executable(options.claudePath ?? "claude", "Claude");
  const scratch = mkdtempSync(path.join(tmpdir(), "claude-sandbox-check-"));
  try {
    const request = { workspace: path.join(scratch, "workspace"), home: path.join(scratch, "home") };
    for (const directory of Object.values(request)) mkdirSync(directory, { mode: 0o700 });
    const settings = claudeWorkerSettings(request, options.artifactRoot, options.privateRoots);
    let stdout: string;
    try {
      ({ stdout } = await run(claude, ["--settings", JSON.stringify(settings), "--setting-sources", CLAUDE_SETTING_SOURCES,
        "sandbox", "status"], { cwd: request.workspace, timeout: CHECK_TIMEOUT_MS, maxBuffer: MAX_CHECK_OUTPUT_BYTES,
        env: workerEnvironment({ HOME: request.workspace, CLAUDE_CONFIG_DIR: request.home, ...CLAUDE_FIXED_ENV }) }));
    } catch { return refuse("claude sandbox status failed"); }
    let status: SandboxStatus;
    try { status = JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as SandboxStatus; }
    catch { return refuse("claude sandbox status returned no posture"); }
    // An invalid --settings document is skipped as a whole in -p mode, which shows here as a disabled sandbox.
    if (status.enabled !== true) {
      return refuse(typeof status.unavailableReason === "string" ? status.unavailableReason.slice(0, 300) : "worker settings were not applied");
    }
    if (status.strictMode !== true) refuse("unsandboxed commands are not disabled");
    if ((options.platform ?? process.platform) !== "linux") return;
    let bwrap: string;
    try { bwrap = executable("bwrap", "bubblewrap"); } catch { return refuse("bubblewrap is not installed"); }
    try { await run(bwrap, BWRAP_TRIAL, { timeout: CHECK_TIMEOUT_MS, maxBuffer: MAX_CHECK_OUTPUT_BYTES, env: workerEnvironment({}) }); }
    catch { refuse("bubblewrap cannot create the user, PID and network namespaces or mount /proc; check the seccomp profile and systempaths"); }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
