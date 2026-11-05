import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { WorkerExecutionRequest, WorkerExecutor } from "./contracts.js";
import { isClaudeEffort, isClaudeModel } from "./claude-models.js";
import { CLAUDE_DENIED_DOMAINS, claudeDeniedHosts } from "./claude-network.js";
import { parseOutput } from "./output.js";
import { executable, runWorkerProcess, workerEnvironment } from "./process.js";

/** Built-in tools roughly matching the Codex worker: shell, file edits, reads and web. */
export const CLAUDE_WORKER_TOOLS = ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch", "WebSearch"] as const;
/** Tools allowed everywhere. Read, Glob and Grep stay limited to the workspace (the working directory). */
const UNSCOPED_TOOLS = ["Bash", "WebFetch", "WebSearch"] as const;
const PROTECTED_ROOTS = ["/etc/super-leader", "/proc"] as const;
// Session settings only come from the isolated config dir; workspace-written
// project or local settings must never widen the worker's permissions.
export const CLAUDE_SETTING_SOURCES = "user";
export const CLAUDE_FIXED_ENV = {
  DISABLE_AUTOUPDATER: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  // Removes Anthropic credentials from the environment of Bash and hook subprocesses.
  CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
} as const;

export interface ClaudeExecutorOptions {
  artifactRoot: string;
  /** Worker root and controller state; Bash and file tools may read only their own workspace inside them. */
  privateRoots?: string[];
  claudePath?: string;
  /** Claude model alias or full name; the CLI default applies when unset. */
  model?: string;
  /** Anthropic-compatible endpoint, passed as ANTHROPIC_BASE_URL. */
  baseUrl?: string;
  /** Sent as x-api-key (ANTHROPIC_API_KEY). */
  apiKey?: string;
  /** Sent as Authorization: Bearer (ANTHROPIC_AUTH_TOKEN). */
  authToken?: string;
  oauthToken?: string;
}

/**
 * The CLI appends `/claude-<uid>` to CLAUDE_CODE_TMPDIR and gives sandboxed Bash
 * the shared system temp root instead once that exceeds 44 bytes (AF_UNIX path
 * limits). `/tmp/slc-<12 chars>/claude-1000` stays at 33 bytes.
 */
export const CLAUDE_TEMP_PREFIX = "slc-";
const TEMP_ID_CHARS = 12;

/**
 * Per-worker parent for CLAUDE_CODE_TMPDIR. The shared temp root stays closed
 * to sandboxed Bash, so concurrent workers never see each other's temp files.
 */
export function claudeTempRoot(workspace: string): string {
  return path.join(tmpdir(), `${CLAUDE_TEMP_PREFIX}${path.basename(path.dirname(workspace)).slice(0, TEMP_ID_CHARS)}`);
}

/**
 * The CLI keeps its own temp files and sandbox proxy sockets under TMPDIR and
 * gives sandboxed Bash `${CLAUDE_CODE_TMPDIR}/claude-<uid>`; both stay inside the
 * per-worker directory that the sandbox re-opens.
 */
export function claudeTempEnvironment(temp: string) { return { TMPDIR: temp, CLAUDE_CODE_TMPDIR: temp }; }

/** Claude permission rules address absolute paths with a leading `//`. */
function subtree(root: string): string { return `/${root.replace(/\/+$/, "")}/**`; }

/**
 * `deniedHosts` defaults to the fixed names; each turn adds the addresses they
 * resolve to (see claudeDeniedHosts).
 */
export function claudeWorkerSettings(request: Pick<WorkerExecutionRequest, "workspace" | "home">, artifactRoot: string,
  privateRoots: readonly string[] = [], deniedHosts: readonly string[] = CLAUDE_DENIED_DOMAINS) {
  const denied = [request.home, artifactRoot, ...PROTECTED_ROOTS].map(subtree);
  const temp = claudeTempRoot(request.workspace);
  return {
    permissions: {
      allow: [...UNSCOPED_TOOLS, `Read(${subtree(request.workspace)})`, `Edit(${subtree(request.workspace)})`],
      // WebFetch runs outside the sandbox and ignores sandbox.network, so it gets the same denials.
      deny: [...denied.flatMap(rule => [`Read(${rule})`, `Edit(${rule})`]), ...deniedHosts.map(host => `WebFetch(domain:${host})`)],
      // File tools start from nothing outside the workspace (the working directory) in every permission mode.
      blockReadsOutsideWorkingDirectories: true,
    },
    sandbox: {
      // Bash runs inside bubblewrap (Linux) or Seatbelt (macOS) with writes
      // limited to the working directory and the per-worker $TMPDIR. Claude
      // exits instead of running commands unsandboxed when the sandbox cannot start.
      enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false,
      // A bind-mounted container /proc would expose other processes' environments.
      enableWeakerNestedSandbox: false,
      // Public hosts stay reachable through the sandbox proxy, like the Codex worker's
      // shell; the Compose peers, this container and cloud metadata do not.
      network: { allowedDomains: ["*"], deniedDomains: [...deniedHosts] },
      // The narrower allowRead re-opens only this worker's workspace and temp
      // directory inside the private roots. With the credential scrub on, the
      // CLI ignores a deny on the temp root itself, so every entry under it is
      // denied instead: concurrent workers and the controller keep their temp
      // files unreadable and unwritable to each other. allowWrite keeps the
      // re-opened per-worker $TMPDIR (which also holds the proxy sockets) writable.
      filesystem: { denyRead: [artifactRoot, ...privateRoots, path.join(tmpdir(), "*")], allowRead: [request.workspace, temp],
        allowWrite: [temp] },
    },
    // Controller owns worker concurrency, continuation and expiry.
    disableAllHooks: true,
  };
}

export class ClaudeCliExecutor implements WorkerExecutor {
  readonly kind = "claude" as const;
  constructor(private readonly options: ClaudeExecutorOptions) {
    const credentials = [options.apiKey, options.authToken, options.oauthToken].filter(Boolean).length;
    if (credentials !== 1) throw new Error("Claude background executor requires exactly one credential");
  }

  async execute(request: WorkerExecutionRequest): Promise<string> {
    if (request.signal.aborted) throw new Error("Worker execution cancelled before launch");
    const command = executable(this.options.claudePath ?? "claude", "Claude");
    const schema = JSON.stringify(JSON.parse(readFileSync(request.schemaPath, "utf8")));
    const settings = claudeWorkerSettings(request, this.options.artifactRoot, this.options.privateRoots, await claudeDeniedHosts());
    // A console choice applies only when it names a Claude model; a stored Codex model never reaches the CLI.
    const model = isClaudeModel(request.model) ? request.model : this.options.model;
    const effort = isClaudeEffort(request.reasoningEffort) ? request.reasoningEffort : undefined;
    const args = ["-p", "--verbose", "--output-format", "stream-json", "--json-schema", schema,
      "--permission-mode", "dontAsk", "--permission-prompts", "none",
      "--tools", CLAUDE_WORKER_TOOLS.join(","), "--allowedTools", settings.permissions.allow.join(","),
      "--settings", JSON.stringify(settings), "--setting-sources", CLAUDE_SETTING_SOURCES,
      "--strict-mcp-config", "--disable-slash-commands", "--no-chrome",
      ...(model ? ["--model", model] : []),
      ...(effort ? ["--effort", effort] : []),
      ...(request.threadId ? ["--resume", request.threadId] : [])];
    const temp = claudeTempRoot(request.workspace);
    const env = workerEnvironment({ HOME: request.workspace, CLAUDE_CONFIG_DIR: request.home, ...claudeTempEnvironment(temp),
      ...CLAUDE_FIXED_ENV });
    if (this.options.baseUrl) env.ANTHROPIC_BASE_URL = this.options.baseUrl;
    if (this.options.apiKey) env.ANTHROPIC_API_KEY = this.options.apiKey;
    else if (this.options.authToken) env.ANTHROPIC_AUTH_TOKEN = this.options.authToken;
    else if (this.options.oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = this.options.oauthToken;
    let session: string | undefined;
    let result: Record<string, any> | undefined;
    // Turn-scoped: the process group (and every Bash descendant) is gone before removal.
    rmSync(temp, { recursive: true, force: true });
    mkdirSync(temp, { mode: 0o700 });
    return runWorkerProcess(request, { label: "Claude", command, args, env,
      onEvent: (event, context) => {
        if (typeof event.session_id === "string" && event.session_id && event.session_id !== session) {
          session = event.session_id;
          context.thread(event.session_id);
        }
        if (event.type !== "result") return;
        if (result) { context.fail("Claude reported more than one worker result"); return; }
        result = event;
        if (event.subtype !== "success" || event.is_error !== false) context.fail("Claude reported a failed worker turn");
      },
      finish: code => {
        if (code !== 0 || !session || result?.structured_output === undefined) {
          throw new Error("Worker ended without a verified complete turn");
        }
        const text = JSON.stringify(result.structured_output);
        parseOutput(text);
        return text;
      } }).finally(() => rmSync(temp, { recursive: true, force: true }));
  }
}
