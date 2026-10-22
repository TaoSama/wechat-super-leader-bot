import { ChoiceSelect } from "../../../components/ui/ChoiceSelect";
import { useMemo, useState } from "react";
import { ArrowUpRight, CheckCircle2, ChevronDown, Clock, AlertTriangle, Radio, XCircle } from "lucide-react";
import { CommandRecord, COMMAND_STATUS_SEMANTICS, ScopedSession } from "../../../types";
import { formatTimestamp, formatRelativeAge } from "../../../format";
import { CommandFilter, matchesCommandFilter } from "../command-filters";
import { canCancelWebQueue, QueuedCommandCancel } from "./QueuedCommandCancel";
import { CommandDetails } from "./CommandDetails";

interface Props {
  commands: CommandRecord[];
  selectedNodeId: string | null;
  sessions?: ScopedSession[];
  onOpenSession?: (session: ScopedSession) => void;
  statusFilter: CommandFilter;
  onStatusFilterChange: (filter: CommandFilter) => void;
  onClearNodeFilter?: () => void;
}
export const RECENT_COMMAND_LIMIT = 50;
const GROUPS = [
  { key: "attention", title: "需要处理", description: "优先核查异常与未确认的结果", statuses: ["uncertain", "failed", "expired"] },
  { key: "running", title: "执行中", description: "排队、等待响应或已经受理，最终结果尚未确认", statuses: ["queued", "pending", "accepted"] },
  { key: "input", title: "终端输入已写入", description: "仅输入投递结束，执行未确认；不是任务完成，勿自动重发", statuses: ["input-written"] },
  { key: "completed", title: "最近完成", description: "已收到最终回执的指令", statuses: ["completed"] },
  { key: "cancelled", title: "已取消", description: "已从队列移除的消息", statuses: ["cancelled"] },
] as const;
const STATUS_ICONS = { queued: Clock, pending: Clock, accepted: Radio, "input-written": AlertTriangle, completed: CheckCircle2, failed: XCircle, uncertain: AlertTriangle, cancelled: XCircle, expired: AlertTriangle };

export function CommandsSection({ commands, selectedNodeId, sessions = [], onOpenSession, statusFilter, onStatusFilterChange, onClearNodeFilter }: Props) {
  const [receipts, setReceipts] = useState<Record<string, CommandRecord>>({});
  const recent = useMemo(() => commands.map(command => receipts[command.commandId] ?? command).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, RECENT_COMMAND_LIMIT), [commands, receipts]);
  const filtered = recent.filter(command => (!selectedNodeId || command.nodeId === selectedNodeId) && matchesCommandFilter(command.status, statusFilter));
  const hasFilter = statusFilter !== "ALL" || !!selectedNodeId;
  function clearFilters() { onStatusFilterChange("ALL"); if (selectedNodeId) onClearNodeFilter?.(); }

  return <section className="command-section" aria-labelledby="commands-heading">
    <div className="section-heading"><h2 id="commands-heading">指令动态 <span>{filtered.length}</span></h2>
      <div className="status-filter"><span>状态筛选</span><ChoiceSelect label="按指令状态过滤" value={statusFilter} onChange={value => onStatusFilterChange(value as CommandFilter)} options={[
        { value: "ALL", label: "全部状态" }, { value: "attention", label: "需要处理" }, { value: "running", label: "执行中" },
        ...Object.entries(COMMAND_STATUS_SEMANTICS).map(([value, semantics]) => ({ value, label: semantics.label, description: semantics.description })),
      ]} /></div>
    </div>
    <div className="command-filter-summary"><p className="section-description">最近 {RECENT_COMMAND_LIMIT} 条 · 异常与执行中优先，已完成收起。</p>
      {hasFilter && <button type="button" className="ui-button ghost" onClick={clearFilters}>{selectedNodeId && !onClearNodeFilter ? "清除状态筛选" : "清空指令筛选"}</button>}
    </div>
    {!filtered.length && <div role="status" className="empty-panel"><Clock size={24} aria-hidden="true" /><h3>暂无匹配的指令审计记录</h3><p>{commands.length ? "更换状态或机器筛选，查看其他记录。" : "从微信或已有会话发送消息后，指令状态会显示在这里。"}</p></div>}
    {GROUPS.map((group) => {
      const items = filtered.filter((command) => (group.statuses as readonly string[]).includes(command.status));
      if (!items.length) return null;
      const heading = <div className="group-heading"><h3>{group.title}<span>{items.length}</span></h3><p>{group.description}</p></div>;
      const list = <div className="command-list">{items.map((command) => {
          const semantics = COMMAND_STATUS_SEMANTICS[command.status];
          const Icon = STATUS_ICONS[command.status];
          const session = sessions.find((item) => item.nodeId === command.nodeId && item.id === command.sessionId);
          return <article key={command.commandId} className={`command-row status-${command.status}`} data-testid={`command-item-${command.commandId}`}>
            <div className="command-main"><div className="command-title-line">{session && onOpenSession ? <button className="command-session-link" type="button" onClick={() => onOpenSession(session)}>{session.title || "未命名会话"}<ArrowUpRight size={15} aria-hidden="true" /></button> : <h4>{session?.title || "会话未在当前快照中"}</h4>}<time title={formatTimestamp(command.updatedAt)}>{formatRelativeAge(command.updatedAt || command.createdAt)}</time></div>
              <p className="command-preview">{command.prompt || (command.action === "read" ? "读取会话状态与历史" : "发送到会话的消息未记录摘要")}</p>
              <div className="command-meta"><span>{command.nodeId}</span><span>{command.action === "send" ? "发送消息" : "读取会话"}</span><span className={`status-badge status-${command.status}`} data-testid={`command-status-${command.commandId}`}><Icon size={14} aria-hidden="true" />{semantics.label}</span></div>
              {(command.status === "uncertain" || command.status === "accepted" || command.status === "input-written") && <p className="command-caution">{semantics.description}</p>}
              {command.error && <p className="command-error">{command.error}</p>}
              {canCancelWebQueue(command) && <QueuedCommandCancel command={command} onReceipt={receipt => setReceipts(previous => ({ ...previous, [receipt.commandId]: receipt }))} />}
            </div>
            <CommandDetails command={command} />
          </article>;
        })}</div>;
      return <section className={`command-group group-${group.key}`} key={group.key} aria-label={group.title}>
        {group.key === "completed" || group.key === "cancelled"
          ? <details className="command-history" key={statusFilter} open={statusFilter === group.key}>
              <summary>{heading}<span className="command-history-action">{group.key === "cancelled" ? "查看已取消" : "查看已完成"}<ChevronDown size={16} aria-hidden="true" /></span></summary>{list}
            </details>
          : <>{heading}{list}</>}
      </section>;
    })}
  </section>;
}
