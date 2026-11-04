import { readFileSync } from "node:fs";
import type { WorkerExecutionRequest, WorkerExecutor } from "./contracts.js";
import { parseOutput } from "./output.js";
import { executable, runWorkerProcess, workerEnvironment } from "./process.js";

/** Built-in tools roughly matching the Codex worker: shell, file edits, reads and web. */
export const CLAUDE_WORKER_TOOLS = ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch", "WebSearch"] as const;
const CLAUDE_EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);
const PROTECTED_ROOTS = ["/etc/super-leader", "/proc"] as const;
// Session settings only come from the isolated config dir; workspace-written
// project or local settings must never widen the worker's permissions.
const SETTING_SOURCES = "user";
const CLAUDE_FIXED_ENV = {
  DISABLE_AUTOUPDATER: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  // Removes Anthropic credentials from the environment of Bash and hook subprocesses.
  CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
} as const;

export interface ClaudeExecutorOptions {
  artifactRoot: string;
  claudePath?: string;
  /** Claude model alias or full name; the CLI default applies when unset. */
  model?: string;
  apiKey?: string;
  oauthToken?: string;
}

/** Claude permission rules address absolute paths with a leading `//`. */
function subtree(root: string): string { return `/${root.replace(/\/+$/, "")}/**`; }

export function claudeWorkerSettings(request: Pick<WorkerExecutionRequest, "workspace" | "home">, artifactRoot: string) {
  const denied = [request.home, artifactRoot, ...PROTECTED_ROOTS].map(subtree);
  return {
    permissions: {
      allow: [...CLAUDE_WORKER_TOOLS.filter(tool => tool !== "Edit" && tool !== "Write"), `Edit(${subtree(request.workspace)})`],
      deny: denied.flatMap(rule => [`Read(${rule})`, `Edit(${rule})`]),
    },
    // Bash runs inside the OS sandbox, whose writes are limited to the working
    // directory; commands may not fall back to running unsandboxed.
    sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false },
    // Controller owns worker concurrency, continuation and expiry.
    disableAllHooks: true,
  };
}

export class ClaudeCliExecutor implements WorkerExecutor {
  constructor(private readonly options: ClaudeExecutorOptions) {
    if (!options.apiKey && !options.oauthToken) throw new Error("Claude background executor requires a credential");
  }

  async execute(request: WorkerExecutionRequest): Promise<string> {
    if (request.signal.aborted) throw new Error("Worker execution cancelled before launch");
    const command = executable(this.options.claudePath ?? "claude", "Claude");
    const schema = JSON.stringify(JSON.parse(readFileSync(request.schemaPath, "utf8")));
    const settings = claudeWorkerSettings(request, this.options.artifactRoot);
    const effort = request.reasoningEffort && CLAUDE_EFFORT_LEVELS.has(request.reasoningEffort) ? request.reasoningEffort : undefined;
    const args = ["-p", "--verbose", "--output-format", "stream-json", "--json-schema", schema,
      "--permission-mode", "dontAsk", "--permission-prompts", "none",
      "--tools", CLAUDE_WORKER_TOOLS.join(","), "--allowedTools", settings.permissions.allow.join(","),
      "--settings", JSON.stringify(settings), "--setting-sources", SETTING_SOURCES,
      "--strict-mcp-config", "--disable-slash-commands", "--no-chrome",
      ...(this.options.model ? ["--model", this.options.model] : []),
      ...(effort ? ["--effort", effort] : []),
      ...(request.threadId ? ["--resume", request.threadId] : [])];
    const env = workerEnvironment({ HOME: request.workspace, CLAUDE_CONFIG_DIR: request.home, ...CLAUDE_FIXED_ENV });
    if (this.options.apiKey) env.ANTHROPIC_API_KEY = this.options.apiKey;
    else if (this.options.oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = this.options.oauthToken;
    let session: string | undefined;
    let result: Record<string, any> | undefined;
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
      } });
  }
}
