import { useRef } from "react";
import { ArrowUp } from "lucide-react";
import { COMMAND_STATUS_SEMANTICS, type ScopedSession } from "../../../types";
import { modelSourceLabel, type selectModelObservation } from "../model-observation";
import { sendRouteLabel } from "../send-availability";
import type { useSessionMessages } from "../useSessionMessages";

interface Props {
  session: ScopedSession;
  model: ReturnType<typeof selectModelObservation>;
  messages: ReturnType<typeof useSessionMessages>;
  terminal: boolean;
  mobile: boolean;
  connected: boolean;
  busy: boolean;
  blockReason: string | null;
  pending: boolean;
  onSend: () => void;
  onRecover: () => void;
}

export function SessionComposer({ session, model, messages, terminal, mobile, connected, busy, blockReason, pending, onSend, onRecover }: Props) {
  const composingRef = useRef(false);
  const submission = messages.submission;
  const guidance = blockReason || (pending ? submission?.command?.status === "queued" ? "已排队，等待会话继续" : "正在确认发送结果…" : !connected ? "设备离线，发送后等待连接" : busy ? "会话忙碌，发送后排队" : mobile ? "" : "Enter 发送 · Shift + Enter 换行");
  return <form className="composer" onSubmit={event => { event.preventDefault(); onSend(); }}>
    {submission && <div className={`send-receipt ${submission.uncertain ? "receipt-uncertain" : submission.command?.status === "failed" ? "receipt-failed" : ""}`} role={submission.uncertain || submission.command?.status === "failed" ? "alert" : "status"}>
      <span>{submission.command ? COMMAND_STATUS_SEMANTICS[submission.command.status].label : "提交结果待核查"}</span>
      {(submission.uncertain || submission.command && ["failed", "accepted", "input-written"].includes(submission.command.status)) && <p>{submission.uncertain ? "结果不确定，请手动核查；恢复将沿用同一个请求。" : COMMAND_STATUS_SEMANTICS[submission.command!.status].description}</p>}
      {submission.command?.status === "queued" && <><p>消息已排队，会在会话可以继续时发送。</p><button type="button" disabled={messages.sending || messages.cancelling} onClick={() => void messages.cancel()}>{messages.cancelling ? "正在取消…" : "取消排队"}</button></>}
      {(submission.uncertain || messages.pollingStopped) && <button type="button" disabled={messages.sending || messages.cancelling} onClick={onRecover}>核查发送状态</button>}
      <details className="receipt-details"><summary>{submission.command?.status === "completed" ? "查看最终回执" : "查看发送详情"}</summary>
        <p className="receipt-prompt">{submission.prompt}</p>
        {submission.command?.sendRoute && <p>发送通道：{sendRouteLabel(submission.command.sendRoute)}</p>}
        {!submission.uncertain && submission.command && !["failed", "accepted", "input-written"].includes(submission.command.status) && <p>{COMMAND_STATUS_SEMANTICS[submission.command.status].description}</p>}
        {submission.command?.status === "completed" && submission.command.output && <pre>{submission.command.output}</pre>}
      </details>
    </div>}
    {messages.error && <p role="alert" className="composer-error">{messages.error}</p>}
    {terminal && session.sendAvailability?.route === "terminal-pane" && <p className="composer-route" role="status">发送到原终端，写入后仍需确认执行结果。</p>}
    <label className="composer-label sr-only" htmlFor="message-draft">发送给当前会话</label>
    <div className="composer-input">
      <textarea aria-label="发送给当前会话" aria-describedby="send-guidance" id="message-draft" rows={2} value={messages.draft} onChange={event => messages.setDraft(event.target.value)} placeholder="继续这个会话…" disabled={messages.sending || pending}
        onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={() => { composingRef.current = false; }}
        onKeyDown={event => { if (!mobile && event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !composingRef.current && event.keyCode !== 229) { event.preventDefault(); onSend(); } }} />
      <div className="composer-toolbar"><span className="composer-model" title={modelSourceLabel(model.source)}>{model.model || "模型未报告"}{model.reasoningEffort && <span className="composer-effort"> · {model.reasoningEffort}</span>}</span>
        <button type="submit" className="send-button" aria-label={messages.sending ? "发送中…" : "发送消息"} aria-describedby="send-guidance" disabled={!!blockReason || pending || messages.sending || !messages.draft.trim()}><span className="send-button-chrome"><ArrowUp size={16} aria-hidden="true" /></span></button>
      </div>
    </div>
    <div className="composer-footer"><span id="send-guidance" role="status">{guidance}</span></div>
  </form>;
}
