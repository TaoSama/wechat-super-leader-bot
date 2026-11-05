import { createHash } from "node:crypto";

/** Placeholder for per-chat rules only; the shared rules live in the leader system prompt. */
const AGENT_INSTRUCTIONS = `# 本聊天的补充规则

在这里写只对这个微信聊天生效的规则，例如常用会话的叫法、固定的汇报格式。
通用规则已经由系统提供，不用在这里重复。
`;
const REVISION_HEADER = /^<!-- default-revision: ([a-f0-9]{64}) -->\n/;
export const digest = (content: string) => createHash("sha256").update(content, "utf8").digest("hex");
const DEFAULT_REVISION = digest(AGENT_INSTRUCTIONS);
/** sha256 of each earlier unedited AGENTS.md body; headed copies of later defaults upgrade through their own header. */
const HEADERLESS_DEFAULT_REVISIONS = new Set([
  "c91067a11f9199496be0e3ac9c566b96d7b8313c4b60f436048b8cf9a9d99730",
  "2d7792622c3eccca780fb6d7e55ff51cef71c1db1d1284765a93e648c154296c",
  "0e0bbe02906ecb7324d00d0bc1cecca8bc5f103f777499867d12b5de6137384b",
]);

const revisionHeader = (revision: string) => `<!-- default-revision: ${revision} -->\n`;

/** The header records which default the body came from, so an unedited body proves itself. */
export const DEFAULT_AGENT_INSTRUCTIONS = `${revisionHeader(DEFAULT_REVISION)}${AGENT_INSTRUCTIONS}`;

/**
 * current: the deployed default. outdated-default: an unedited older default, safe to replace.
 * stale: edited from an older default, or edited before the header existed; left alone.
 * custom: edited from the current default.
 */
type AgentInstructionsStatus = "current" | "outdated-default" | "stale" | "custom";
export function agentInstructionsStatus(content: string): AgentInstructionsStatus {
  const header = content.match(REVISION_HEADER);
  if (!header) return HEADERLESS_DEFAULT_REVISIONS.has(digest(content)) ? "outdated-default" : "stale";
  const unedited = digest(content.slice(header[0].length)) === header[1];
  if (header[1] === DEFAULT_REVISION) return unedited ? "current" : "custom";
  return unedited ? "outdated-default" : "stale";
}

/** A user save confirms the current default was reviewed, so the body is re-based on it. */
export function rebaseAgentInstructions(content: string): string {
  return revisionHeader(DEFAULT_REVISION) + content.replace(REVISION_HEADER, "");
}
