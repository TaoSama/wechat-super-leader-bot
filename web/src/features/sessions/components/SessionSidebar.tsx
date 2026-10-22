import { useMemo, useState, type RefObject } from "react";
import { MessageSquare, Search, Server } from "lucide-react";
import type { ScopedSession } from "../../../types";
import type { DerivedNodeStatus } from "../../status/useStatusPolling";
import { projectName } from "../../../format";
import { selectExecutionObservation } from "../session-observation";
import { modelSourceLabel, selectModelObservation } from "../model-observation";
import { sessionKey } from "../useSessionHistory";
import { SessionStatus } from "./SessionStatus";
import { ChoiceSelect } from "../../../components/ui/ChoiceSelect";

interface Props {
  sessions: ScopedSession[];
  nodes: DerivedNodeStatus[];
  now: number;
  selectedKey: string | null;
  listRef: RefObject<HTMLDivElement | null>;
  onScroll: (position: number) => void;
  onOpen: (key: string) => void;
}

export function SessionSidebar({ sessions, nodes, now, selectedKey, listRef, onScroll, onOpen }: Props) {
  const [query, setQuery] = useState("");
  const [nodeFilter, setNodeFilter] = useState("");
  const visibleSessions = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return sessions.filter(session => {
      const model = selectModelObservation(session, now);
      return (!nodeFilter || session.nodeId === nodeFilter) && (!search ||
        [session.title, session.cwd, session.nodeId, model.model, model.modelProvider, session.id]
          .some(value => value?.toLocaleLowerCase().includes(search)));
    }).sort((a, b) => (b.updatedAt ?? b.observedAt).localeCompare(a.updatedAt ?? a.observedAt));
  }, [sessions, query, nodeFilter, now]);

  return <aside className="session-sidebar" aria-label="机器与会话">
    <div className="sidebar-toolbar"><div className="sidebar-heading"><h2>会话 <span>{visibleSessions.length}</span></h2></div>
    <div className="machine-filter"><ChoiceSelect label="筛选机器" value={nodeFilter} onChange={setNodeFilter} options={[{ value: "", label: "全部机器" }, ...nodes.map(node => ({ value: node.nodeId, label: node.nodeId, description: node.connected ? "在线" : "离线" }))]} /></div>
    </div>
    <label className="search-field"><Search size={14} aria-hidden="true" /><input aria-label="搜索会话" placeholder="搜索会话" value={query} onChange={event => setQuery(event.target.value)} /></label>
    <div className="session-list" ref={listRef} onScroll={event => onScroll(event.currentTarget.scrollTop)}>
      {nodes.filter(node => !nodeFilter || node.nodeId === nodeFilter).map(node => {
        const group = visibleSessions.filter(session => session.nodeId === node.nodeId);
        if (!group.length) return null;
        return <section key={node.nodeId} className="machine-group" aria-label={`机器 ${node.nodeId}`}>
          <h3><Server size={14} aria-hidden="true" /><span>{node.nodeId}</span><span className={`connection ${node.connected ? "online" : "offline"}`}>{node.connected ? "在线" : "离线"}</span></h3>
          {group.map(session => {
            const { executionStatus } = selectExecutionObservation(session, now);
            const model = selectModelObservation(session, now);
            const key = sessionKey(session);
            return <button key={key} type="button" className={`session-choice ${key === selectedKey ? "selected" : ""}`} aria-pressed={key === selectedKey} onClick={() => onOpen(key)} data-testid={`session-row-${session.nodeId}-${session.id}`}>
              <span className="session-row-leading"><SessionStatus status={executionStatus} /></span>
              <span className="session-row-content">
                <span className="session-title-line"><span className="session-title">{session.title || "未命名会话"}</span></span>
                <span className="session-bottom-line"><span className="session-project" title={session.cwd}>{projectName(session.cwd)}</span><span className="session-model" title={modelSourceLabel(model.source)}>{model.model || "模型未报告"}</span></span>
              </span>
            </button>;
          })}
        </section>;
      })}
      {!visibleSessions.length && <div className="sidebar-empty"><MessageSquare size={24} aria-hidden="true" /><p>{sessions.length ? "没有匹配的会话" : "暂无会话"}</p><span>可更换机器或搜索条件</span></div>}
    </div>
  </aside>;
}
