const SESSION_STATUS_LABELS: Record<string, string> = {
  active: "执行中", busy: "执行中", running: "执行中",
  blocked: "需要回复", awaiting_input: "等待输入",
  idle: "空闲", done: "已完成", error: "错误", notLoaded: "未加载",
};

export function sessionStatusLabel(status: string): string | null {
  return Object.hasOwn(SESSION_STATUS_LABELS, status) ? SESSION_STATUS_LABELS[status] : null;
}

export function SessionStatus({ status, showLabel = false }: { status: string; showLabel?: boolean }) {
  const label = sessionStatusLabel(status);
  const description = label ?? "状态未知";
  return <>
    <span className={`session-status-dot state-${status}`} role="img" aria-label={description} />
    {showLabel && label && <span className={`session-state state-${status}`}>{label}</span>}
  </>;
}
