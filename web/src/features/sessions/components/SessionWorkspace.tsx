import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowDown, Search, Server, MessageSquare, Send, RefreshCw, Info } from "lucide-react";
import { ControlPlaneStatusResponse, COMMAND_STATUS_SEMANTICS, type DesktopObservation } from "../../../types";
import { DerivedNodeStatus } from "../../status/useStatusPolling";
import { sessionKey, useSessionHistory } from "../useSessionHistory";
import { sendBlockReason, useSessionMessages } from "../useSessionMessages";
import { HistoryMessage } from "./HistoryMessage";
import { useHistoryScroll } from "../useHistoryScroll";
import { formatRelativeAge, formatTimestamp, projectName } from "../../../format";
import { describeDesktopObservation, isDesktopObservationFresh, MAX_DESKTOP_OBSERVATION_AGE_MS, selectExecutionObservation } from "../session-observation";
import { canResumeSession, MAX_SEND_AVAILABILITY_AGE_MS, sendRouteLabel } from "../send-availability";
import { modelSourceLabel, selectModelObservation } from "../model-observation";
import { isTerminalSession, MAX_TERMINAL_OBSERVATION_AGE_MS } from "../terminal-session";
import { hasTerminalHistorySource } from "../history-contract";
import { useSessionNavigation } from "../useSessionNavigation";
import { SessionDetails } from "./SessionDetails";

interface Props {
  data: ControlPlaneStatusResponse;
  nodes: DerivedNodeStatus[];
  stale: boolean;
  onAuthFailure: () => void;
  active?: boolean;
  requestedSessionKey?: string | null;
  requestedSessionRevision?: number;
  onDetailVisibilityChange?: (visible: boolean) => void;
}

const STATUS_NAMES: Record<string, string> = { idle: "空闲", active: "执行中", busy: "执行中", running: "执行中", blocked: "等待处理", notLoaded: "未加载", unknown: "状态未知" };

export function SessionWorkspace({ data, nodes, stale, onAuthFailure, active = true, requestedSessionKey, requestedSessionRevision, onDetailVisibilityChange }: Props) {
  const { selectedKey, detailVisible, mobile, openSession, backToList } = useSessionNavigation();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [nodeFilter, setNodeFilter] = useState("");
  const [observationRevision, setObservationRevision] = useState(0);
  const observationNow = Date.now();
  const selected = data.sessions.find((session) => sessionKey(session) === selectedKey) ?? null;
  const selectedTerminal = !!selected && isTerminalSession(selected);
  const selectedObservation = selected ? selectExecutionObservation(selected, observationNow) : null;
  const selectedModel = selected ? selectModelObservation(selected, observationNow) : null;
  const selectedDesktopDescription = selectedTerminal ? null : describeDesktopObservation(selected?.desktopObservation, observationNow);
  const selectedDesktopNotice = selectedTerminal ? null : desktopObservationNotice(selected?.desktopObservation, observationNow);
  const connected = nodes.some((node) => node.nodeId === selected?.nodeId && node.connected);
  const history = useSessionHistory(selected, connected && active && detailVisible, onAuthFailure);
  const showHistory = !selectedTerminal || !!selected && hasTerminalHistorySource(selected) || !!history.history;
  const messages = useSessionMessages(selected, onAuthFailure);
  const blockReason = sendBlockReason(selected, connected, stale, observationNow);
  const submission = messages.submission;
  const pending = !!submission && (submission.uncertain || ["pending", "accepted", "uncertain"].includes(submission.command?.status ?? ""));
  const historyOwner = JSON.stringify([selectedKey, history.requestedSource]);
  const scroll = useHistoryScroll({ owner: historyOwner, items: history.history?.items ?? [], nextCursor: history.history?.nextCursor ?? null, loadingOlder: history.loadingOlder, automaticLoadPaused: history.sizeBlocked, loadOlder: history.loadOlder });
  const headingRef = useRef<HTMLHeadingElement>(null);
  const composingRef = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  const listScrollRef = useRef(0);
  const historyPositionsRef = useRef(new Map<string, number>());
  const navigationRef = useRef({ selectedKey, detailVisible });
  const visibleSessions = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return data.sessions.filter((session) => {
      const model = selectModelObservation(session, observationNow);
      return (!nodeFilter || session.nodeId === nodeFilter) && (!search ||
        [session.title, session.cwd, session.nodeId, model.model, model.modelProvider, session.id].some((value) => value?.toLocaleLowerCase().includes(search)));
    })
      .sort((a, b) => (b.updatedAt ?? b.observedAt).localeCompare(a.updatedAt ?? a.observedAt));
  }, [data.sessions, query, nodeFilter, observationNow]);

  useLayoutEffect(() => {
    const previous = navigationRef.current;
    navigationRef.current = { selectedKey, detailVisible };
    if (!active || previous.selectedKey === selectedKey && previous.detailVisible === detailVisible) return;
    if (detailVisible) headingRef.current?.focus();
    else if (previous.detailVisible) {
      const selectedButton = listRef.current?.querySelector<HTMLButtonElement>(".session-choice.selected");
      selectedButton?.focus({ preventScroll: true });
    }
  }, [active, selectedKey, detailVisible]);
  useLayoutEffect(() => {
    if (detailVisible) {
      const container = scroll.scrollRef.current;
      if (container) container.scrollTop = historyPositionsRef.current.get(historyOwner) ?? container.scrollHeight;
    }
    else {
      if (listRef.current) listRef.current.scrollTop = listScrollRef.current;
    }
  }, [selectedKey, detailVisible, historyOwner]);
  useEffect(() => {
    onDetailVisibilityChange?.(active && detailVisible && !!selected);
  }, [active, detailVisible, !!selected, onDetailVisibilityChange]);
  useEffect(() => () => onDetailVisibilityChange?.(false), [onDetailVisibilityChange]);
  useEffect(() => { setDetailsOpen(false); }, [active, detailVisible, selectedKey]);
  useEffect(() => {
    if (requestedSessionKey) openSession(requestedSessionKey);
  }, [requestedSessionKey, requestedSessionRevision, openSession]);
  useEffect(() => {
    if (!active) return;
    const now = Date.now();
    const expiries = data.sessions.flatMap(session => {
      const desktop = session.desktopObservation;
      const observedAt = desktop?.observedAt ? Date.parse(desktop.observedAt) : NaN;
      const candidates: number[] = [];
      if (isTerminalSession(session)) candidates.push(Date.parse(session.observedAt) + MAX_TERMINAL_OBSERVATION_AGE_MS);
      if (desktop?.availability === "available" && observedAt <= now) candidates.push(observedAt + MAX_DESKTOP_OBSERVATION_AGE_MS);
      if (session.sendAvailability?.state === "ready") candidates.push(Date.parse(session.sendAvailability.validUntil));
      if ((!session.sendAvailability && session.loaded === true) || session.capabilities.includes("resume-send")) candidates.push(Date.parse(session.observedAt) + MAX_SEND_AVAILABILITY_AGE_MS);
      return candidates.filter(expiry => Number.isFinite(expiry) && expiry >= now);
    });
    if (!expiries.length) return;
    const timer = window.setTimeout(() => setObservationRevision(revision => revision + 1), Math.min(...expiries) - now + 1);
    return () => window.clearTimeout(timer);
  }, [active, data.sessions, observationRevision]);

  function send() {
    // Background tabs may delay timers. Recheck expiry at the actual gesture.
    if (sendBlockReason(selected, connected, stale)) {
      setObservationRevision(revision => revision + 1);
      return;
    }
    if (!pending && !messages.sending) void messages.submit();
  }

  function recover() {
    if (!submission?.command && sendBlockReason(selected, connected, stale)) {
      setObservationRevision(revision => revision + 1);
      return;
    }
    void messages.submit(true);
  }

  return <div className={`session-workspace ${selected && detailVisible ? "has-selection" : ""}`}>
    <aside className="session-sidebar" aria-label="机器与会话">
      <div className="sidebar-heading"><div><h2>会话 <span>{visibleSessions.length}</span></h2></div><span className="sidebar-hint">从上次进展继续</span></div>
      <label className="search-field"><Search size={17} aria-hidden="true" /><input aria-label="搜索会话" placeholder="搜索标题、目录或模型" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <label className="machine-filter"><span>机器</span><select className="filter-select" aria-label="筛选机器" value={nodeFilter} onChange={(event) => setNodeFilter(event.target.value)}><option value="">全部机器</option>{nodes.map((node) => <option key={node.nodeId} value={node.nodeId}>{node.nodeId}{node.connected ? " · 在线" : " · 离线"}</option>)}</select></label>
      <div className="session-list" ref={listRef} onScroll={(event) => { if (!mobile || !detailVisible) listScrollRef.current = event.currentTarget.scrollTop; }}>
        {nodes.filter((node) => !nodeFilter || node.nodeId === nodeFilter).map((node) => {
          const sessions = visibleSessions.filter((session) => session.nodeId === node.nodeId);
          if (!sessions.length && (query || nodeFilter)) return null;
          return <section key={node.nodeId} className="machine-group" aria-label={`机器 ${node.nodeId}`}>
            <h3><Server size={14} aria-hidden="true" /><span>{node.nodeId}</span><span className={`connection ${node.connected ? "online" : "offline"}`}>{node.connected ? "在线" : "离线"}</span></h3>
            {sessions.map((session) => {
              const { executionStatus } = selectExecutionObservation(session, observationNow);
              const terminal = isTerminalSession(session);
              const desktopNotice = terminal ? null : desktopObservationNotice(session.desktopObservation, observationNow);
              const model = selectModelObservation(session, observationNow);
              return <button key={sessionKey(session)} type="button" className={`session-choice ${sessionKey(session) === selectedKey ? "selected" : ""}`} aria-pressed={sessionKey(session) === selectedKey} onClick={() => openSession(sessionKey(session))} data-testid={`session-row-${session.nodeId}-${session.id}`}>
              <span className="session-title-line"><span className="session-title">{session.title || "未命名会话"}</span><span className={`session-state state-${executionStatus}`}>{STATUS_NAMES[executionStatus] || executionStatus}</span></span>
              <span className="session-preview">{session.preview || (terminal ? hasTerminalHistorySource(session) ? "终端观测 · CLI 会话记录" : "终端观测 · 只读状态，非对话历史" : "暂无消息摘要 · 打开查看历史")}</span>
              {desktopNotice && <span className="session-observation session-observation-warning">{desktopNotice}</span>}
              <span className="session-bottom-line"><span className="session-model" title={modelSourceLabel(model.source)}>{model.model || "模型未报告"}</span><span className="session-project" title={session.cwd}>{projectName(session.cwd)}</span><time title={formatTimestamp(session.updatedAt || session.observedAt)}>{formatRelativeAge(session.updatedAt || session.observedAt)}</time></span>
            </button>;
            })}
            {!sessions.length && <p className="empty-small">暂无会话</p>}
          </section>;
        })}
        {!visibleSessions.length && <div className="sidebar-empty"><MessageSquare size={24} aria-hidden="true" /><p>{data.sessions.length ? "未匹配到符合条件的宿主会话" : "暂无会话"}</p><span>可更换机器或搜索条件</span></div>}
      </div>
    </aside>

    <section className="session-detail" aria-label="会话工作区">
      {!selected || !detailVisible ? <div className="workspace-empty"><span className="empty-workspace-icon"><MessageSquare size={28} aria-hidden="true" /></span><p className="eyebrow">PICK UP WHERE YOU LEFT OFF</p><h2>接着上次的进展</h2><p>选择左侧会话，阅读历史并继续交流。</p><span>机器、模型和最近消息，已为你整理在一起</span></div> : <>
        <header className="detail-heading">
          <div className="session-header-main">
            <button type="button" className="mobile-back" aria-label="返回会话列表" onClick={backToList}><ArrowLeft size={20} aria-hidden="true" /></button>
            <div className="session-header-copy"><div className="detail-title"><h2 ref={headingRef} tabIndex={-1} title={selected.title || "未命名会话"}>{selected.title || "未命名会话"}</h2><span className={`status-label state-${selectedObservation!.executionStatus}`}>{STATUS_NAMES[selectedObservation!.executionStatus] || selectedObservation!.executionStatus}</span></div>
              <div className="detail-subline"><span className="detail-model" title={modelSourceLabel(selectedModel!.source)}>{selectedModel?.model || "模型未报告"}</span><span className="session-machine">{selected.nodeId}</span><span title={selected.cwd}>{projectName(selected.cwd)}</span></div>
            </div>
            <button type="button" className="session-details-button icon-button" aria-label="会话详情" aria-haspopup="dialog" onClick={() => setDetailsOpen(true)}><Info size={20} aria-hidden="true" /><span>详情</span></button>
          </div>
          {selectedDesktopNotice && <p className="session-observation-warning" role="status">{selectedDesktopNotice}</p>}
          {showHistory && <div className="history-controls desktop-history-controls"><span>{history.history ? `历史更新于 ${formatDate(history.history.fetchedAt)}` : "正在准备会话历史"}</span><button type="button" onClick={() => void history.refresh()} disabled={history.loadingLatest || !history.canRead || history.contextExpired} aria-label="刷新会话历史"><RefreshCw size={14} aria-hidden="true" />刷新历史</button></div>}
          {history.requestedSource === "control-socket" && <div className="history-source-notice" role="status"><span>已切换为原生分页历史</span><button type="button" className="text-button" onClick={() => setDetailsOpen(true)}>查看来源</button></div>}
          {history.contextExpired && <div role="alert" className="notice error history-context-notice">{history.error}<button type="button" disabled={!history.canRead} onClick={() => void history.resetLatest()}>重新读取最新页</button></div>}
        </header>
        {!showHistory ? <div className="history-scroll" aria-label="终端观测说明"><div className="history-content"><p>{selected.sendAvailability?.route === "terminal-pane" ? "此会话提供终端运行状态与独立单步输入，未接入完整对话历史。" : "此会话仅提供终端运行状态，尚未接入完整对话历史与发送。"}</p><p>可在微信中明确询问这个会话的最新输出，读取有限终端快照。快照可能裁剪，不是完整对话记录。</p><p>空闲仅是终端宿主报告的生命周期状态，不代表某项任务已完成。模型未提供可信信息时不作推断。</p></div></div> : <div className="history-scroll" ref={scroll.scrollRef} tabIndex={0} aria-label="会话历史" onScroll={(event) => { historyPositionsRef.current.set(historyOwner, event.currentTarget.scrollTop); scroll.onScroll(); }}>
          <div className="history-content">
            {selectedTerminal && <p className="muted">CLI 会话记录来自原 CLI 的结构化可见文本；终端快照不是对话历史。读取记录不提供发送资格或任务完成证明。</p>}
            {history.history?.nextCursor && <button type="button" className="older-button" disabled={history.loadingOlder || !history.canRead} onClick={() => void scroll.loadOlder()}>{history.loadingOlder ? "正在读取更早消息…" : "加载更早的消息"}</button>}
            {history.windowNotice && <div className="history-window-notice" role="status">{history.windowNotice}{!history.contextExpired && <button type="button" className="text-button" disabled={history.loadingLatest || !history.canRead} onClick={() => void history.resetLatest()}>仅保留最新消息</button>}</div>}
            {history.pollingPaused && !history.contextExpired && !history.sizeBlocked && <div role="status" className="notice">{history.readBlockReason || "自动更新已暂停，可手动刷新继续读取。"}<button type="button" disabled={history.loading || !history.canRead} onClick={() => void history.resetLatest()}>重新读取最新页</button></div>}
            {history.error && !history.contextExpired && !history.readBlockReason && <div role="alert" className="notice error">{history.error}<button type="button" onClick={() => void history.refresh()} disabled={history.loading || !history.canRead}>重试读取</button><button type="button" disabled={!history.canRead} onClick={() => void history.resetLatest()}>重新读取最新页</button></div>}
            {history.error && !selectedTerminal && history.requestedSource !== "control-socket" && <div className="notice"><span>长会话可改用原生分页接口，读取同一会话的已保存历史，不加载整份桌面快照。</span><button type="button" disabled={!history.canRead} onClick={() => void history.usePagedHistory()}>使用分页历史接口</button></div>}
            {history.loading && !history.history && <p role="status" className="history-loading">正在读取会话历史…</p>}
            {history.history?.items.map((item) => <div key={item.id}>{history.gapBeforeIds.includes(item.id) && <div role="status" className="notice history-gap">此处还有未加载的消息，历史不连续。{!history.contextExpired && (history.memoryGap ? <button type="button" disabled={history.loadingLatest || !history.canRead} onClick={() => void history.resetLatest()}>重新读取最新页</button> : <button type="button" disabled={history.loadingOlder || !history.canRead} onClick={() => void scroll.loadOlder()}>补齐这段历史</button>)}</div>}<HistoryMessage item={item} /></div>)}
            {history.history && !history.history.items.length && <p className="history-loading">这段会话暂时没有可显示的消息</p>}
            {history.history?.truncated && <p className="muted">部分历史内容已裁剪</p>}
          </div>
        </div>}
        <div className="session-bottom-slot">
        {showHistory && scroll.newContent && <div className="latest-message-slot"><button type="button" className="new-message-button" onClick={() => { scroll.jumpLatest(); if (scroll.scrollRef.current) historyPositionsRef.current.set(historyOwner, scroll.scrollRef.current.scrollTop); }}><ArrowDown size={16} aria-hidden="true" />有新消息 · 跳到最新</button></div>}
        <form className="composer" onSubmit={(event) => { event.preventDefault(); send(); }}>
          {submission && <div className={`send-receipt ${submission.uncertain ? "receipt-uncertain" : submission.command?.status === "failed" ? "receipt-failed" : ""}`} role={submission.uncertain || submission.command?.status === "failed" ? "alert" : "status"}>
            <span>{submission.command ? COMMAND_STATUS_SEMANTICS[submission.command.status].label : "提交结果待核查"}</span>
            {(submission.uncertain || submission.command && ["failed", "accepted", "input-written"].includes(submission.command.status)) && <p>{submission.uncertain ? "结果不确定，请手动核查；恢复将沿用同一个请求。" : COMMAND_STATUS_SEMANTICS[submission.command!.status].description}</p>}
            {(submission.uncertain || messages.pollingStopped) && <button type="button" disabled={messages.sending || (!submission.command && !!blockReason)} onClick={recover}>{submission.command ? "核查发送状态" : "恢复原请求"}</button>}
            <details className="receipt-details"><summary>{submission.command?.status === "completed" ? "查看最终回执" : "查看发送详情"}</summary>
              {submission.command?.sendRoute && <p>发送通道：{sendRouteLabel(submission.command.sendRoute)}</p>}
              {!submission.uncertain && submission.command && !["failed", "accepted", "input-written"].includes(submission.command.status) && <p>{COMMAND_STATUS_SEMANTICS[submission.command.status].description}</p>}
              {submission.command?.status === "completed" && submission.command.output && <pre>{submission.command.output}</pre>}
            </details>
          </div>}
          {messages.error && <p role="alert" className="composer-error">{messages.error}</p>}
          {!selectedTerminal && (canResumeSession(selected, observationNow) || selected.sendAvailability) && <details className="composer-route-details"><summary>{canResumeSession(selected, observationNow) ? "可按需恢复原会话 · 执行时检查占用" : blockReason ? "原桌面发送通道 · 暂不可用" : "通过原桌面会话发送 · 保留原会话设置"}</summary><p>消息发送至当前选中的原会话。发送前会重新检查状态和占用，回执确认前请勿重复发送。</p></details>}
          {selectedTerminal && selected.sendAvailability?.route === "terminal-pane" && <p className="composer-route" role="status">原终端输入 · 非原子：CLI 退出、同类进程替换或人工输入可能与投递竞态。输入已写入，执行未确认；不是任务完成，勿自动重发。</p>}
          <label className="composer-label" htmlFor="message-draft">发送给当前会话<span aria-hidden="true">{selectedModel?.model || "模型未报告"}</span></label>
          <textarea aria-label="发送给当前会话" aria-describedby="send-guidance" id="message-draft" rows={2} value={messages.draft} onChange={(event) => messages.setDraft(event.target.value)} placeholder="继续这个会话…" disabled={messages.sending || pending} onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={() => { composingRef.current = false; }} onKeyDown={(event) => { if (!mobile && event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !composingRef.current && event.keyCode !== 229) { event.preventDefault(); send(); } }} />
          <div className="composer-footer"><span id="send-guidance" role="status">{blockReason || (pending ? "正在核查本次发送，请等待回执" : mobile ? "Enter 换行 · 点击发送" : "Enter 发送 · Shift + Enter 换行")}</span><button type="submit" className="send-button" aria-describedby="send-guidance" disabled={!!blockReason || pending || messages.sending || !messages.draft.trim()}><Send size={16} aria-hidden="true" />{messages.sending ? "发送中…" : "发送消息"}</button></div>
        </form>
        </div>
        {detailsOpen && <SessionDetails onClose={() => setDetailsOpen(false)}>
          <dl className="session-metadata"><div><dt>标题</dt><dd>{selected.title || "未命名会话"}</dd></div><div><dt>机器</dt><dd>{selected.nodeId}{connected ? " · 在线" : " · 离线"}</dd></div><div><dt>工作目录</dt><dd>{selected.cwd || "目录未报告"}</dd></div><div><dt>模型</dt><dd>{selectedModel?.model || "模型未报告"}</dd></div><div><dt>Provider</dt><dd>{selectedModel?.modelProvider || "未报告"}</dd></div><div><dt>推理强度</dt><dd>{selectedModel?.reasoningEffort || "未报告"}</dd></div><div><dt>模型来源</dt><dd>{modelSourceLabel(selectedModel!.source)}</dd></div><div><dt>模型观测时间</dt><dd>{selectedModel?.observedAt ? formatTimestamp(selectedModel.observedAt) : "未报告"}</dd></div><div><dt>会话 ID</dt><dd>{selected.id}</dd></div><div><dt>最近更新</dt><dd>{formatTimestamp(selected.updatedAt || selected.observedAt)}</dd></div></dl>
          {selectedDesktopDescription && <div className="detail-subline"><span>{selectedDesktopDescription}</span><span>控制接口：{STATUS_NAMES[selected.status] || selected.status}</span></div>}
          {selectedTerminal && <div className="detail-subline"><span>终端观测 · {selected.provider}</span><span>观测于 {formatTimestamp(selected.observedAt)}</span></div>}
          {showHistory && <div className="history-controls"><span>{selectedTerminal && "CLI 会话记录 · "}{history.history ? `历史更新于 ${formatDate(history.history.fetchedAt)}` : "正在准备会话历史"}</span><button type="button" onClick={() => void history.refresh()} disabled={history.loadingLatest || !history.canRead || history.contextExpired} aria-label="从详情刷新会话历史"><RefreshCw size={14} aria-hidden="true" />刷新历史</button></div>}
          {history.requestedSource === "control-socket" && <div className="detail-subline" role="status"><span>原生分页历史 · 读取同一会话的已保存记录，可能稍有延迟；不改变发送通道。</span><button type="button" className="text-button" disabled={!history.canRead} onClick={() => void history.useAutomaticHistory()}>恢复自动来源</button></div>}
        </SessionDetails>}
      </>}
    </section>
  </div>;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "未报告" : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function desktopObservationNotice(observation: DesktopObservation | undefined, now: number): string | null {
  if (!observation) return null;
  if (observation.availability === "unavailable") return "桌面已失联";
  if (!observation.observedAt) return "桌面观测时间缺失";
  if (Date.parse(observation.observedAt) > now) return "桌面观测时间异常";
  if (!isDesktopObservationFresh(observation, now)) return "桌面观测已过期";
  if (observation.status === "unknown") return "桌面状态未知";
  return null;
}
