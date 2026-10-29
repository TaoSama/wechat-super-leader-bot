const MAX_CHAT_SUBAGENTS = 2;
const DOCS_STARTUP_TIMEOUT_SECONDS = 10;
const DOCS_TOOL_TIMEOUT_SECONDS = 30;
const AUTO_COMPACT_TOKEN_LIMIT = 64_000;
const AUTO_COMPACT_TOKEN_LIMIT_SCOPE = "body_after_prefix";
const POST_TURN_COMPACT_THRESHOLD_PERCENT = 90;
export const HEADLESS_SKILLS_ROOT = "/etc/codex/skills";

export const HEADLESS_CODEX_CONFIG = {
  // Compact the native history before it reaches the latency cliff. Thread
  // rotation remains a fallback when a native runtime cannot compact.
  model_auto_compact_token_limit: AUTO_COMPACT_TOKEN_LIMIT,
  model_auto_compact_token_limit_scope: AUTO_COMPACT_TOKEN_LIMIT_SCOPE,
  model_post_turn_compact_threshold_percent: POST_TURN_COMPACT_THRESHOLD_PERCENT,
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
    context_management: { experimental_mode: true },
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
