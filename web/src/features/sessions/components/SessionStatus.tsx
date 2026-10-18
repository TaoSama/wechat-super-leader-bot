const ACTIVE_STATUSES = new Set(["active", "busy", "running"]);

export function sessionStatusLabel(status: string): string | null {
  if (ACTIVE_STATUSES.has(status)) return "执行中";
  if (status === "blocked") return "需要回复";
  return null;
}

export function SessionStatus({ status, showLabel = false }: { status: string; showLabel?: boolean }) {
  const label = sessionStatusLabel(status);
  const description = label ?? (status === "idle" ? "空闲" : "状态未知");
  return <>
    <span className={`session-status-dot state-${status}`} role="img" aria-label={description} />
    {showLabel && label && <span className={`session-state state-${status}`}>{label}</span>}
  </>;
}
