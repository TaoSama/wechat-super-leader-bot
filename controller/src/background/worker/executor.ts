import { realpathSync } from "node:fs";
import * as path from "node:path";
import type { WorkerExecutionRequest, WorkerExecutor, WorkerRuntimeOptions } from "./contracts.js";
import { executable, runWorkerProcess, workerEnvironment } from "./process.js";

const DOCS_STARTUP_TIMEOUT_SECONDS = 10;
const DOCS_TOOL_TIMEOUT_SECONDS = 30;
const HEADLESS_SKILLS_ROOT = "/etc/codex/skills";

export class CodexCliExecutor implements WorkerExecutor {
  readonly kind = "codex" as const;
  constructor(private readonly options: WorkerRuntimeOptions) {}

  async execute(request: WorkerExecutionRequest): Promise<string> {
    if (request.signal.aborted) throw new Error("Worker execution cancelled before launch");
    const command = executable(this.options.codexPath ?? "codex", "Codex");
    const nodePath = realpathSync(process.execPath);
    const shellPath = [path.dirname(nodePath), "/usr/local/bin", "/usr/bin", "/bin"].join(path.delimiter);
    const nodeLibraries = process.platform === "darwin"
      ? [...new Set(((process.report.getReport() as { sharedObjects?: string[] }).sharedObjects ?? [])
        .filter(file => file.startsWith("/opt/homebrew/Cellar/") && file.endsWith(".dylib"))
        .flatMap(file => [path.dirname(file), "/opt/homebrew/opt"]))]
      : [];
    // The runtime package is readable; other worker homes, controller files and
    // process environments are outside this worker's filesystem capability.
    // Keep the default outside-workspace denial. Denying its ancestors as well
    // prevents Linux's filesystem helper from constructing the home mount.
    const filesystem = [[":minimal", "read"], [this.options.artifactRoot, "deny"], [request.workspace, "write"],
      [HEADLESS_SKILLS_ROOT, "read"],
      [request.home, "deny"], ["/etc/super-leader", "deny"], ["/proc", "deny"],
      [path.resolve(path.dirname(command), ".."), "read"],
      [path.resolve(path.dirname(nodePath), ".."), "read"], ...nodeLibraries.map(file => [file, "read"])]
      .map(([file, access]) => `${JSON.stringify(file)}=${JSON.stringify(access)}`).join(",");
    const config = [
      `permissions.background_worker={filesystem={${filesystem}},network={enabled=true}}`,
      'default_permissions="background_worker"', 'approval_policy="never"',
      'web_search="live"',
      'features.shell_tool=true', 'features.unified_exec=true', 'features.shell_snapshot=true',
      'features.skill_search=true', 'features.view_image=true', 'features.sleep_tool=true',
      // Bundled skill files are inside the worker home denied to shell tools.
      'skills.bundled.enabled=false',
      'features.browser_use=false', 'features.browser_use_external=false',
      'features.browser_use_full_cdp_access=false', 'features.browser_annotation_api=false',
      'features.in_app_browser=false', 'features.in_app_local_automation=false', 'features.computer_use=false',
      `mcp_servers.openaiDeveloperDocs={url="https://developers.openai.com/mcp",required=false,startup_timeout_sec=${DOCS_STARTUP_TIMEOUT_SECONDS},tool_timeout_sec=${DOCS_TOOL_TIMEOUT_SECONDS}}`,
      'shell_environment_policy.inherit="none"',
      // Controller owns worker concurrency, continuation and expiry.
      'features.multi_agent=false', 'features.multi_agent_v2=false', 'features.goals=false', 'features.hooks=false',
      `shell_environment_policy.set=${JSON.stringify({ PATH: shellPath, HOME: request.workspace,
        ...(process.platform === "darwin" ? { OPENSSL_CONF: "/dev/null" } : {}) })
        .replace(/"([^"\\]+)":/g, '"$1"=')}`,
      'shell_environment_policy.exclude=["CODEX_API_KEY","OPENAI_API_KEY"]',
    ];
    if (this.options.baseUrl) config.push('model_provider="background_api"',
      `model_providers.background_api={name="Background API",base_url=${JSON.stringify(this.options.baseUrl)},env_key="CODEX_API_KEY",wire_api="responses",supports_standalone_web_search=true}`);
    if (request.reasoningEffort) config.push(`model_reasoning_effort=${JSON.stringify(request.reasoningEffort)}`);
    const args = ["exec", "--json", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check",
      "--model", request.model ?? this.options.model, "--output-schema", request.schemaPath,
      ...config.flatMap(value => ["--config", value]),
      ...(request.threadId ? ["resume", request.threadId] : []), "-"];
    const env = workerEnvironment({ HOME: request.workspace, CODEX_HOME: request.home });
    if (this.options.apiKey) env.CODEX_API_KEY = this.options.apiKey;
    let output = "";
    let completed = false;
    return runWorkerProcess(request, { label: "Codex", command, args, env,
      onEvent: (event, context) => {
        if (event.type === "thread.started") context.thread(event.thread_id);
        if (event.type === "item.completed" && event.item?.type === "agent_message") output = event.item.text;
        if (event.type === "turn.completed") completed = true;
        if (event.type === "turn.failed" || event.type === "error") context.fail("Codex reported a failed worker turn");
      },
      finish: code => {
        if (code !== 0 || !completed || !output.trim()) throw new Error("Worker ended without a verified complete turn");
        return output;
      } });
  }
}
