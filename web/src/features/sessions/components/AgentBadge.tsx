import { AGENT_KIND_LABELS, type AgentKind } from "../agent-kind";

export function AgentBadge({ kind }: { kind: AgentKind | null | undefined }) {
  if (!kind) return null;
  const label = AGENT_KIND_LABELS[kind];
  return <span className={`agent-badge agent-${kind}`} title={`类型：${label}`}>{label}</span>;
}
