/** Shown and stored when no Claude model is configured; the CLI then uses its own default. */
export const CLAUDE_DEFAULT_MODEL_LABEL = "claude-cli-default";
export const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
/** CLI aliases that always resolve to the current model of each family. */
export const CLAUDE_MODEL_ALIASES = [
  { id: "sonnet", label: "Claude Sonnet（最新）" },
  { id: "opus", label: "Claude Opus（最新）" },
  { id: "haiku", label: "Claude Haiku（最新）" },
] as const;
// Full names, optionally behind a gateway vendor prefix such as `anthropic/`.
const CLAUDE_FULL_MODEL_NAME = /^(?:[a-z0-9][a-z0-9_-]{0,39}\/)?claude-[a-z0-9][a-z0-9.@:-]{0,99}(\[1m\])?$/;

/** True for a value the Claude CLI accepts as --model; Codex model IDs and the default label are excluded. */
export function isClaudeModel(model: string | undefined): model is string {
  if (!model || model === CLAUDE_DEFAULT_MODEL_LABEL) return false;
  return CLAUDE_MODEL_ALIASES.some(alias => alias.id === model) || CLAUDE_FULL_MODEL_NAME.test(model);
}

export function isClaudeEffort(effort: string | null | undefined): effort is typeof CLAUDE_EFFORT_LEVELS[number] {
  return !!effort && (CLAUDE_EFFORT_LEVELS as readonly string[]).includes(effort);
}
