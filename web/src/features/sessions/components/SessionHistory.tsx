import type { ScopedSession } from "../../../types";
import type { useSessionHistory } from "../useSessionHistory";
import type { useHistoryScroll } from "../useHistoryScroll";
import { HistoryMessage } from "./HistoryMessage";

interface Props {
  session: ScopedSession;
  terminal: boolean;
  showHistory: boolean;
  history: ReturnType<typeof useSessionHistory>;
  scroll: ReturnType<typeof useHistoryScroll>;
}

export function SessionHistory({ session, terminal, showHistory, history, scroll }: Props) {
  if (!showHistory) return <div className="history-scroll" aria-label="终端观测说明"><div className="history-content">
    <p>{session.sendAvailability?.route === "terminal-pane" ? "此会话提供终端运行状态与单步输入，暂未接入完整对话历史。" : "此会话提供终端运行状态，暂未接入对话历史与发送。"}</p>
    <p>可以在微信中询问这个会话的最新输出，读取有限的终端快照。快照可能裁剪，不是完整对话记录。</p>
  </div></div>;

  return <div className="history-scroll" ref={scroll.scrollRef} tabIndex={0} aria-label="会话历史" onScroll={scroll.onScroll}>
    <div className="history-content">
      {terminal && <p className="muted">终端会话记录 · 仅显示已保存的内容</p>}
      {history.history?.nextCursor && <button type="button" className="older-button" disabled={history.loadingOlder || !history.canRead} onClick={() => void scroll.loadOlder()}>{history.loadingOlder ? "正在读取更早消息…" : "加载更早的消息"}</button>}
      {history.windowNotice && <div className="history-window-notice" role="status">{history.windowNotice}{!history.contextExpired && <button type="button" className="text-button" disabled={history.loadingLatest || !history.canRead} onClick={() => void history.resetLatest()}>仅保留最新消息</button>}</div>}
      {history.pollingPaused && !history.contextExpired && !history.sizeBlocked && <div role="status" className="notice">{history.readBlockReason || "自动更新已暂停，可手动刷新继续读取。"}<button type="button" disabled={history.loading || !history.canRead} onClick={() => void history.resetLatest()}>重新读取最新页</button></div>}
      {history.error && !history.contextExpired && !history.readBlockReason && <div role="alert" className="notice error">{history.error}<button type="button" onClick={() => void history.refresh()} disabled={history.loading || !history.canRead}>重试读取</button><button type="button" disabled={!history.canRead} onClick={() => void history.resetLatest()}>重新读取最新页</button></div>}
      {history.error && !terminal && history.requestedSource !== "control-socket" && <div className="notice"><span>内容较多时，可以换一种方式读取。</span><button type="button" disabled={!history.canRead} onClick={() => void history.usePagedHistory()}>重新加载会话</button></div>}
      {history.loading && !history.history && <div role="status" className="history-skeleton"><span className="sr-only">正在读取会话历史…</span>{[0, 1, 2].map(row => <div key={row} className={`message-skeleton ${row === 1 ? "skeleton-user" : ""}`} aria-hidden="true"><i /><i /><i /></div>)}</div>}
      {history.history?.items.map(item => <div key={item.id}>
        {history.gapBeforeIds.includes(item.id) && <div role="status" className="notice history-gap">此处还有未加载的消息，历史不连续。{!history.contextExpired && (history.memoryGap ? <button type="button" disabled={history.loadingLatest || !history.canRead} onClick={() => void history.resetLatest()}>重新读取最新页</button> : <button type="button" disabled={history.loadingOlder || !history.canRead} onClick={() => void scroll.loadOlder()}>补齐这段历史</button>)}</div>}
        <HistoryMessage item={item} />
      </div>)}
      {history.history && !history.history.items.length && <p className="history-loading">这段会话暂时没有可显示的消息</p>}
      {history.history?.truncated && <p className="muted">部分历史内容已裁剪</p>}
    </div>
  </div>;
}
