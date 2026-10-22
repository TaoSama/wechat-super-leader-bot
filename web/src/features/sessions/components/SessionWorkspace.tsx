import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowDown, Ellipsis } from "lucide-react";
import type { ControlPlaneStatusResponse } from "../../../types";
import type { DerivedNodeStatus } from "../../status/useStatusPolling";
import { sessionKey, useSessionHistory } from "../useSessionHistory";
import { sendBlockReason, useSessionMessages } from "../useSessionMessages";
import { useHistoryScroll } from "../useHistoryScroll";
import { projectName } from "../../../format";
import { MAX_DESKTOP_OBSERVATION_AGE_MS, selectExecutionObservation } from "../session-observation";
import { MAX_SEND_AVAILABILITY_AGE_MS } from "../send-availability";
import { selectModelObservation } from "../model-observation";
import { isTerminalSession, MAX_TERMINAL_OBSERVATION_AGE_MS } from "../terminal-session";
import { hasTerminalHistorySource } from "../history-contract";
import { useSessionNavigation } from "../useSessionNavigation";
import { SessionSidebar } from "./SessionSidebar";
import { SessionHistory } from "./SessionHistory";
import { SessionComposer } from "./SessionComposer";
import { SessionInfo } from "./SessionInfo";
import { SessionStatus } from "./SessionStatus";

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

export function SessionWorkspace({ data, nodes, stale, onAuthFailure, active = true, requestedSessionKey, requestedSessionRevision, onDetailVisibilityChange }: Props) {
  const { selectedKey, detailVisible, mobile, openSession, backToList } = useSessionNavigation();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [observationRevision, setObservationRevision] = useState(0);
  const observationNow = Date.now();
  const selected = data.sessions.find(session => sessionKey(session) === selectedKey) ?? null;
  const selectedTerminal = !!selected && isTerminalSession(selected);
  const selectedObservation = selected ? selectExecutionObservation(selected, observationNow) : null;
  const selectedModel = selected ? selectModelObservation(selected, observationNow) : null;
  const connected = nodes.some(node => node.nodeId === selected?.nodeId && node.connected);
  const history = useSessionHistory(selected, connected && active && detailVisible, onAuthFailure);
  const showHistory = !selectedTerminal || !!selected && hasTerminalHistorySource(selected) || !!history.history;
  const messages = useSessionMessages(selected, onAuthFailure);
  const blockReason = sendBlockReason(selected, connected, stale, observationNow);
  const submission = messages.submission;
  const pending = !!submission && (submission.uncertain || ["admitting", "queued", "pending", "accepted", "uncertain"].includes(submission.command?.status ?? ""));
  const historyOwner = JSON.stringify([selectedKey, history.requestedSource]);
  const scroll = useHistoryScroll({ owner: historyOwner, visible: active && detailVisible, items: history.history?.items ?? [], nextCursor: history.history?.nextCursor ?? null, loadingOlder: history.loadingOlder, automaticLoadPaused: history.sizeBlocked, loadOlder: history.loadOlder, onReadingLatestChange: history.setReadingLatest });
  const headingRef = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listScrollRef = useRef(0);
  const navigationRef = useRef({ selectedKey, detailVisible });

  useLayoutEffect(() => {
    const previous = navigationRef.current;
    navigationRef.current = { selectedKey, detailVisible };
    if (!active || previous.selectedKey === selectedKey && previous.detailVisible === detailVisible) return;
    if (detailVisible) headingRef.current?.focus();
    else if (previous.detailVisible) listRef.current?.querySelector<HTMLButtonElement>(".session-choice.selected")?.focus({ preventScroll: true });
  }, [active, selectedKey, detailVisible]);
  useLayoutEffect(() => {
    if (!detailVisible && listRef.current) listRef.current.scrollTop = listScrollRef.current;
  }, [detailVisible]);
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
    // Recheck at the gesture because browsers can delay background timers.
    if (sendBlockReason(selected, connected, stale)) {
      setObservationRevision(revision => revision + 1);
      return;
    }
    if (!pending && !messages.sending) void messages.submit();
  }

  return <div className={`session-workspace ${selected && detailVisible ? "has-selection" : ""}`}>
    <SessionSidebar sessions={data.sessions} nodes={nodes} now={observationNow} selectedKey={selectedKey} listRef={listRef} onOpen={openSession} onScroll={position => { if (!mobile || !detailVisible) listScrollRef.current = position; }} />
    <section className="session-detail" aria-label="会话工作区">
      {!selected || !detailVisible ? <div className="workspace-empty"><h2>选择会话，继续工作</h2><p>消息与进展会显示在这里。</p></div> : <>
        <header className="detail-heading">
          <div className="session-header-main">
            <button type="button" className="mobile-back" aria-label="返回会话列表" onClick={backToList}><ArrowLeft size={16} aria-hidden="true" /></button>
            <div className="session-header-copy">
              <div className="detail-title"><h2 ref={headingRef} tabIndex={-1} title={selected.title || "未命名会话"}>{selected.title || "未命名会话"}</h2><SessionStatus status={selectedObservation!.executionStatus} showLabel /></div>
              <div className="detail-subline"><span title={selected.cwd}>{projectName(selected.cwd)}</span><span className="session-machine">{selected.nodeId}</span></div>
            </div>
            <button type="button" className="session-details-button icon-button" aria-label="会话详情" aria-haspopup="dialog" onClick={() => setDetailsOpen(true)}><Ellipsis size={16} aria-hidden="true" /></button>
          </div>
          {history.contextExpired && <div role="alert" className="notice error history-context-notice">{history.error}<button type="button" disabled={!history.canRead} onClick={() => void history.resetLatest()}>重新读取最新页</button></div>}
        </header>
        <SessionHistory session={selected} terminal={selectedTerminal} showHistory={showHistory} history={history} scroll={scroll} />
        <div className="session-bottom-slot">
          {showHistory && scroll.newContent && <div className="latest-message-slot"><button type="button" className="new-message-button" onClick={scroll.jumpLatest}><ArrowDown size={16} aria-hidden="true" />有新消息 · 跳到最新</button></div>}
          <SessionComposer key={selectedKey} session={selected} model={selectedModel!} messages={messages} terminal={selectedTerminal} mobile={mobile} connected={connected} busy={["active", "busy", "running"].includes(selectedObservation!.executionStatus)} blockReason={blockReason} pending={pending} onSend={send} onRecover={() => void messages.submit(true)} />
        </div>
        {detailsOpen && <SessionInfo session={selected} model={selectedModel!} connected={connected} terminal={selectedTerminal} now={observationNow} blockReason={blockReason} showHistory={showHistory} history={history} onClose={() => setDetailsOpen(false)} />}
      </>}
    </section>
  </div>;
}
