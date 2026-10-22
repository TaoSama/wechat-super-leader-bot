import { useId, useMemo, useRef, useState, type RefObject } from "react";
import { ChevronRight, Folder, MessageSquare, Search, X } from "lucide-react";
import type { ScopedSession } from "../../../types";
import type { DerivedNodeStatus } from "../../status/useStatusPolling";
import { selectExecutionObservation } from "../session-observation";
import { selectModelObservation } from "../model-observation";
import { sessionKey } from "../useSessionHistory";
import { groupSessionProjects } from "../project-groups";
import { ChoiceSelect } from "../../../components/ui/ChoiceSelect";

const COMPACT_STATUS: Record<string, string> = {
  active: "忙", busy: "忙", running: "忙", idle: "闲", done: "完",
  blocked: "等", awaiting_input: "等", notLoaded: "未载", unknown: "未知", error: "错",
};

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
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set());
  const listId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const searching = !!query.trim();
  const visibleSessions = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return sessions.filter(session => {
      const model = selectModelObservation(session, now);
      return (!nodeFilter || session.nodeId === nodeFilter) && (!search ||
        [session.title, session.cwd, session.nodeId, model.model, model.modelProvider, session.id]
          .some(value => value?.toLocaleLowerCase().includes(search)));
    });
  }, [sessions, query, nodeFilter, now]);
  const projects = useMemo(() => {
    const groups = groupSessionProjects(visibleSessions);
    const names = new Map<string, number>();
    for (const group of groups) {
      const key = JSON.stringify([group.nodeId, group.name]);
      names.set(key, (names.get(key) ?? 0) + 1);
    }
    let offset = 0;
    return groups.map(project => {
      const start = offset + 1;
      offset += project.sessions.length;
      return { ...project, start, showPath: (names.get(JSON.stringify([project.nodeId, project.name])) ?? 0) > 1 };
    });
  }, [visibleSessions]);
  const nodeMap = useMemo(() => new Map(nodes.map(node => [node.nodeId, node])), [nodes]);

  function toggleProject(key: string) {
    setCollapsedProjects(previous => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return <aside className="session-sidebar" aria-label="项目与会话">
    <div className="sidebar-toolbar"><div className="sidebar-heading"><h2>项目 <span>{projects.length} · {visibleSessions.length} 个会话</span></h2></div>
    <div className="machine-filter"><ChoiceSelect label="筛选机器" value={nodeFilter} onChange={setNodeFilter} options={[{ value: "", label: "全部机器" }, ...nodes.map(node => ({ value: node.nodeId, label: node.nodeId, description: node.connected ? "在线" : "离线" }))]} /></div>
    </div>
    <div className="search-field"><Search size={14} aria-hidden="true" /><input ref={searchRef} aria-label="搜索会话" placeholder="搜索项目或会话" value={query} onChange={event => setQuery(event.target.value)} />{query && <button type="button" aria-label="清除搜索" className="search-clear" onClick={() => { setQuery(""); searchRef.current?.focus(); }}><X size={14} aria-hidden="true" /></button>}</div>
    <p className="sidebar-sort-hint">按最近更新排列</p>
    <div className="session-list" ref={listRef} onScroll={event => onScroll(event.currentTarget.scrollTop)}>
      {projects.map((project, groupIndex) => {
        const expanded = searching || !collapsedProjects.has(project.key);
        const groupId = `${listId}-project-${groupIndex}`;
        const offline = !nodeMap.get(project.nodeId)?.connected;
        const projectLabel = `${project.name}（${project.nodeId}${project.showPath ? ` · ${project.path}` : ""}）`;
        return <section key={project.key} className="project-group" aria-label={projectLabel}>
          <h3><button type="button" className="project-toggle" aria-expanded={expanded} aria-controls={groupId} aria-label={`${expanded ? "收起" : "展开"} ${projectLabel}`} onClick={() => toggleProject(project.key)} disabled={searching} title={project.path || "未关联目录"}>
            <ChevronRight size={14} className="project-chevron" aria-hidden="true" /><Folder size={14} aria-hidden="true" />
            <span className="project-group-copy"><span className="project-group-line"><span className="project-group-name">{project.name}</span><span className={`project-machine ${offline ? "offline" : ""}`}>（{project.nodeId}{offline ? " · 离线" : ""}）</span></span>{project.showPath && <span className="project-group-path">{project.path}</span>}</span><span className="project-count">{project.sessions.length}</span>
          </button></h3>
          <ol id={groupId} className="project-session-list" start={project.start} hidden={!expanded}>
          {project.sessions.map((session, index) => {
            const { executionStatus } = selectExecutionObservation(session, now);
            const key = sessionKey(session);
            return <li key={key}><button type="button" className={`session-choice project-session-choice ${key === selectedKey ? "selected" : ""}`} aria-pressed={key === selectedKey} onClick={() => onOpen(key)} data-testid={`session-row-${session.nodeId}-${session.id}`} title={session.title || "未命名会话"}>
              <span className="session-number" aria-hidden="true">{project.start + index}.</span>
              <span className="session-title">{session.title || "未命名会话"}</span>
              <span className={`session-compact-status state-${executionStatus}`}>{COMPACT_STATUS[executionStatus] ?? "未知"}</span>
            </button></li>;
          })}
          </ol>
        </section>;
      })}
      {!visibleSessions.length && <div className="sidebar-empty"><MessageSquare size={24} aria-hidden="true" /><p>{sessions.length ? "没有匹配的会话" : "暂无会话"}</p><span>可更换机器或搜索条件</span></div>}
    </div>
  </aside>;
}
