import { useRef, useState } from "react";
import { ArrowRight, Bot, CircleCheck, CircleAlert, Radio } from "lucide-react";
import { ControlPlaneStatusResponse, ScopedSession } from "../../../types";
import { DerivedNodeStatus } from "../../status/useStatusPolling";
import { CommandsSection, RECENT_COMMAND_LIMIT } from "./CommandsSection";
import { CommandFilter, matchesCommandFilter } from "../command-filters";
import { NodesSection } from "./NodesSection";
import { ExecutionsSection } from "./ExecutionsSection";
import { GoalsSection } from "./GoalsSection";

interface Props {
  data: ControlPlaneStatusResponse;
  nodes: DerivedNodeStatus[];
  selectedNodeId: string | null;
  onSelectNodeId: (nodeId: string | null) => void;
  onOpenSession: (session: ScopedSession) => void;
  onBrowseSessions: () => void;
}

const COMMAND_SUMMARIES = [
  { filter: "attention", label: "需要处理", Icon: CircleAlert },
  { filter: "running", label: "执行中", Icon: Radio },
  { filter: "completed", label: "最近完成", Icon: CircleCheck },
] as const;

export function LeaderOverview({ data, nodes, selectedNodeId, onSelectNodeId, onOpenSession, onBrowseSessions }: Props) {
  const [commandFilter, setCommandFilter] = useState<CommandFilter>("ALL");
  const commandsRef = useRef<HTMLDivElement>(null);
  const recent = [...data.commands].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, RECENT_COMMAND_LIMIT).filter(command => !selectedNodeId || command.nodeId === selectedNodeId);
  const mode = data.leaderMode;
  const modeLabel = mode === "model" ? "模型 Leader 模式" : mode === "rules" ? "规则模式（未启用模型 Leader）" : "Leader 模式未知";
  const modeDescription = mode === "model"
    ? "已配置模型工具循环；不代表模型当前可用或任务已完成。"
    : mode === "rules"
      ? "当前不具备开放式模型规划；需要配置模型服务后启用。"
      : "Controller 未报告运行模式，不能推断模型已启用。";

  function focusCommands(filter: CommandFilter) {
    setCommandFilter(filter);
    commandsRef.current?.scrollIntoView?.({ block: "start", behavior: "instant" });
    commandsRef.current?.focus({ preventScroll: true });
  }

  return <div className="leader-workspace">
    <header className="leader-heading">
      <div className="leader-heading-copy"><h2>工作看板</h2>
        <section className="leader-model-line" aria-label="Leader 运行模式">
          <Bot size={16} aria-hidden="true" /><span>{modeLabel}</span>
          {data.leaderModel && mode === "model" && <span className="leader-model">{data.leaderModel}</span>}
          <details className="leader-mode-help"><summary>模式说明</summary><p>{modeDescription}</p></details>
        </section>
      </div>
      <button type="button" className="browse-button" onClick={onBrowseSessions}>打开会话<ArrowRight size={17} aria-hidden="true" /></button>
    </header>
    <NodesSection nodes={nodes} selectedNodeId={selectedNodeId} onSelectNodeId={onSelectNodeId} />
    <div className="leader-counts" aria-label="最近指令概览">
      {COMMAND_SUMMARIES.map(({ filter, label, Icon }) => {
        const count = recent.filter(command => matchesCommandFilter(command.status, filter)).length;
        return <button type="button" className={`summary-stat ${commandFilter === filter ? "selected" : ""}`} key={filter}
          aria-label={`查看${label}指令 ${count} 条`} aria-pressed={commandFilter === filter} onClick={() => focusCommands(filter)}>
          <Icon size={17} aria-hidden="true" /><span>{label}</span><strong>{count}</strong>
        </button>;
      })}
    </div>
    <div className="leader-grid">
      {data.goals.items.length > 0 && <GoalsSection goals={data.goals} sessions={data.sessions} selectedNodeId={selectedNodeId} schedulerEnabled={mode === "model"} onOpenSession={onOpenSession} />}
      <ExecutionsSection executions={data.executions} sessions={data.sessions} selectedNodeId={selectedNodeId} schedulerEnabled={mode === "model"} onOpenSession={onOpenSession} />
      <div className="leader-command-anchor" ref={commandsRef} tabIndex={-1} aria-label="指令动态">
        <CommandsSection commands={data.commands} selectedNodeId={selectedNodeId} sessions={data.sessions} onOpenSession={onOpenSession}
          statusFilter={commandFilter} onStatusFilterChange={setCommandFilter} onClearNodeFilter={() => onSelectNodeId(null)} />
      </div>
    </div>
    <details className="leader-footnote"><summary>回执如何解读</summary>
      <p>“已受理”表示输入已接受，执行结果尚未确认。</p>
      <p>“状态存疑”和“输入已写入”需要核验，请勿自动重发。</p>
    </details>
  </div>;
}
