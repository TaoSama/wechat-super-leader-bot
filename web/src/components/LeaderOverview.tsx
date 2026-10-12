import { ArrowRight, Bot, CircleCheck, CircleAlert, Radio } from "lucide-react";
import { ControlPlaneStatusResponse, ScopedSession } from "../types";
import { DerivedNodeStatus } from "../hooks/useStatusPolling";
import { CommandsSection } from "./CommandsSection";
import { NodesSection } from "./NodesSection";
import { ExecutionsSection } from "./ExecutionsSection";
import { GoalsSection } from "./GoalsSection";

interface Props { data: ControlPlaneStatusResponse; nodes: DerivedNodeStatus[]; selectedNodeId: string | null; onSelectNodeId: (nodeId: string | null) => void; onOpenSession: (session: ScopedSession) => void; onBrowseSessions: () => void }

export function LeaderOverview({ data, nodes, selectedNodeId, onSelectNodeId, onOpenSession, onBrowseSessions }: Props) {
  const recent = [...data.commands].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50);
  const mode = data.leaderMode;
  return <div className="leader-workspace">
    <header className="leader-heading"><div><p className="eyebrow">YOUR WORK, IN FOCUS</p><h2>Super Leader</h2><p>看清指令进展，接着处理最重要的事。</p></div><button type="button" className="browse-button" onClick={onBrowseSessions}>打开会话<ArrowRight size={17} aria-hidden="true" /></button></header>
    <div className="leader-summary"><section aria-label="Leader 运行模式" className="leader-mode"><span className="mode-icon"><Bot size={22} aria-hidden="true" /></span><div><h3>{mode === "model" ? "模型 Leader 模式" : mode === "rules" ? "规则模式（未启用模型 Leader）" : "Leader 模式未知"}</h3><p>{mode === "model" ? "已配置模型工具循环；不代表模型当前可用或任务已完成。" : mode === "rules" ? "当前不具备开放式模型规划；需要配置模型服务后启用。" : "Controller 未报告运行模式，不能推断模型已启用。"}</p>{data.leaderModel && mode === "model" && <span className="leader-model">{data.leaderModel}</span>}</div></section>
      <div className="leader-counts">{[{ label: "需要处理", statuses: ["uncertain", "failed"], Icon: CircleAlert }, { label: "执行中", statuses: ["pending", "accepted"], Icon: Radio }, { label: "最近完成", statuses: ["completed"], Icon: CircleCheck }].map(({ label, statuses, Icon }) => <div className="summary-stat" key={label}><Icon size={17} aria-hidden="true" /><span>{label}</span><strong>{recent.filter((command) => statuses.includes(command.status)).length}</strong></div>)}</div>
    </div>
    <div className="leader-grid"><div>{data.goals.items.length > 0 && <GoalsSection goals={data.goals} sessions={data.sessions} selectedNodeId={selectedNodeId} schedulerEnabled={mode === "model"} onOpenSession={onOpenSession} />}<ExecutionsSection executions={data.executions} sessions={data.sessions} selectedNodeId={selectedNodeId} schedulerEnabled={mode === "model"} onOpenSession={onOpenSession} /><CommandsSection commands={data.commands} selectedNodeId={selectedNodeId} sessions={data.sessions} onOpenSession={onOpenSession} /></div><aside><NodesSection nodes={nodes} selectedNodeId={selectedNodeId} onSelectNodeId={onSelectNodeId} /><div className="leader-footnote"><h3>回执如何解读</h3><p>“已受理”表示输入已接受，执行结果尚未确认。</p><p>“状态存疑”需要核验，请勿自动重发。</p></div></aside></div>
  </div>;
}
