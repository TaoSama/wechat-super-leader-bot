const MAX_CHAT_SUBAGENTS = 2;
const DOCS_STARTUP_TIMEOUT_SECONDS = 10;
const DOCS_TOOL_TIMEOUT_SECONDS = 30;
export const HEADLESS_SKILLS_ROOT = "/etc/codex/skills";

export const HEADLESS_CODEX_CONFIG = {
  features: {
    shell_tool: true,
    unified_exec: true,
    shell_snapshot: true,
    skill_search: true,
    view_image: true,
    sleep_tool: true,
    multi_agent: true,
    multi_agent_v2: true,
    goals: true,
    browser_use: false,
    browser_use_external: false,
    browser_use_full_cdp_access: false,
    browser_annotation_api: false,
    in_app_browser: false,
    in_app_local_automation: false,
    computer_use: false,
  },
  // Bundled skill files live inside the private Codex home denied to shell tools.
  skills: { bundled: { enabled: false } },
  // Child threads share the Gateway container's memory and process budgets.
  agents: { max_concurrent_threads_per_session: MAX_CHAT_SUBAGENTS },
  mcp_servers: {
    openaiDeveloperDocs: {
      url: "https://developers.openai.com/mcp",
      required: false,
      startup_timeout_sec: DOCS_STARTUP_TIMEOUT_SECONDS,
      tool_timeout_sec: DOCS_TOOL_TIMEOUT_SECONDS,
    },
  },
};
