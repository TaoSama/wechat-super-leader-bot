import { useMemo, useState } from "react";
import { ArrowUpRight, CheckCircle2, Clock, AlertTriangle, Radio, XCircle } from "lucide-react";
import { CommandRecord, CommandStatus, COMMAND_STATUS_SEMANTICS, ScopedSession } from "../types";
import { formatTimestamp, formatRelativeAge } from "../format";

interface Props {
  commands: CommandRecord[];
  selectedNodeId: string | null;
  sessions?: ScopedSession[];
  onOpenSession?: (session: ScopedSession) => void;
}
const RECENT_COMMAND_LIMIT = 50;
const GROUPS = [
  { key: "attention", title: "需要处理", description: "优先核查异常与未确认的结果", statuses: ["uncertain", "failed"] },
  { key: "running", title: "执行中", description: "等待响应或已经受理，最终结果尚未确认", statuses: ["pending", "accepted"] },
  { key: "input", title: "终端输入已写入", description: "仅输入投递结束，执行未确认；不是任务完成，勿自动重发", statuses: ["input-written"] },
  { key: "completed", title: "最近完成", description: "已收到最终回执的指令", statuses: ["completed"] },
] as const;
const STATUS_ICONS = { pending: Clock, accepted: Radio, "input-written": AlertTriangle, completed: CheckCircle2, failed: XCircle, uncertain: AlertTriangle };

export function CommandsSection({ commands, selectedNodeId, sessions = [], onOpenSession }: Props) {
  const [statusFilter, setStatusFilter] = useState<CommandStatus | "ALL">("ALL");
  const recent = useMemo(() => [...commands].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, RECENT_COMMAND_LIMIT), [commands]);
  const filtered = recent.filter((command) => (!selectedNodeId || command.nodeId === selectedNodeId) && (statusFilter === "ALL" || command.status === statusFilter));

  return <section className="command-section" aria-labelledby="commands-heading">
    <div className="section-heading"><div><p className="eyebrow">COMMAND ACTIVITY</p><h2 id="commands-heading">指令动态 <span>{filtered.length}</span></h2></div>
      <label className="status-filter">状态筛选<select aria-label="按指令状态过滤" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as CommandStatus | "ALL")}><option value="ALL">全部状态</option>{Object.entries(COMMAND_STATUS_SEMANTICS).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}</select></label>
    </div>
    <p className="section-description">最近 {RECENT_COMMAND_LIMIT} 条记录 · 点会话标题继续阅读，展开详情查看完整回执。</p>
    {!filtered.length && <div role="status" className="empty-panel"><Clock size={24} aria-hidden="true" /><h3>暂无匹配的指令审计记录</h3><p>{commands.length ? "更换状态或机器筛选，查看其他记录。" : "从微信或已有会话发送消息后，指令状态会显示在这里。"}</p></div>}
    {GROUPS.map((group) => {
      const items = filtered.filter((command) => (group.statuses as readonly string[]).includes(command.status));
      if (!items.length) return null;
      return <section className={`command-group group-${group.key}`} key={group.key} aria-label={group.title}>
        <div className="group-heading"><h3>{group.title}<span>{items.length}</span></h3><p>{group.description}</p></div>
        <div className="command-list">{items.map((command) => {
          const semantics = COMMAND_STATUS_SEMANTICS[command.status];
          const Icon = STATUS_ICONS[command.status];
          const session = sessions.find((item) => item.nodeId === command.nodeId && item.id === command.sessionId);
          return <article key={command.commandId} className={`command-row status-${command.status}`} data-testid={`command-item-${command.commandId}`}>
            <div className="command-main"><div className="command-title-line">{session && onOpenSession ? <button className="command-session-link" type="button" onClick={() => onOpenSession(session)}>{session.title || "未命名会话"}<ArrowUpRight size={15} aria-hidden="true" /></button> : <h4>{session?.title || "会话未在当前快照中"}</h4>}<time title={formatTimestamp(command.updatedAt)}>{formatRelativeAge(command.updatedAt || command.createdAt)}</time></div>
              <p className="command-preview">{command.prompt || (command.action === "read" ? "读取会话状态与历史" : "发送到会话的消息未记录摘要")}</p>
              <div className="command-meta"><span>{command.nodeId}</span><span>{command.action === "send" ? "发送消息" : "读取会话"}</span><span className={`status-badge status-${command.status}`} data-testid={`command-status-${command.commandId}`}><Icon size={14} aria-hidden="true" />{semantics.label}</span></div>
              {(command.status === "uncertain" || command.status === "accepted" || command.status === "input-written") && <p className="command-caution">{semantics.description}</p>}
              {command.error && <p className="command-error">{command.error}</p>}
            </div>
            <details className="command-details"><summary>指令详情与回执</summary><div className="command-detail-content"><p>{semantics.description}</p><dl><div><dt>会话标识</dt><dd>{command.nodeId} / {command.sessionId}</dd></div><div><dt>指令 ID</dt><dd>{command.commandId}</dd></div><div><dt>请求 ID</dt><dd>{command.requestId}</dd></div></dl>{command.inputReceipt && <dl><div><dt>输入证明</dt><dd>{command.inputReceipt.kind}</dd></div><div><dt>证明会话</dt><dd>{command.inputReceipt.sessionId}</dd></div><div><dt>宿主请求 ID</dt><dd>{command.inputReceipt.requestId}</dd></div><div><dt>实际输入 SHA256</dt><dd>{command.inputReceipt.promptSHA256}</dd></div><div><dt>响应 / 观测版本</dt><dd>{command.inputReceipt.responseRevision} / {command.inputReceipt.observedRevision}</dd></div></dl>}{command.turnId && <p>关联 Turn: {command.turnId}（按该轮次核验，不以会话空闲状态判断完成）</p>}<p>创建: {formatTimestamp(command.createdAt)}</p><p>更新: {formatTimestamp(command.updatedAt)}</p><p>派发截止（非执行时限）: {formatTimestamp(command.expiresAt)}</p>{command.prompt && <div><h5>完整请求</h5><pre>{command.prompt}</pre></div>}{command.output && <div><h5>最终回执 / 返回快照</h5><pre>{command.output}</pre></div>}</div></details>
          </article>;
        })}</div>
      </section>;
    })}
  </section>;
}
