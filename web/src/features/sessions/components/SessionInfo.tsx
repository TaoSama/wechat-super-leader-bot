import { RefreshCw } from "lucide-react";
import type { ScopedSession } from "../../../types";
import { formatTimestamp } from "../../../format";
import { canResumeSession } from "../send-availability";
import { modelSourceLabel, type selectModelObservation } from "../model-observation";
import type { useSessionHistory } from "../useSessionHistory";
import { SessionDetails } from "./SessionDetails";
import { ExecutionTimeline } from "../execution-timeline";
import { hasWechatHistorySource } from "../history-contract";

interface Props {
  session: ScopedSession;
  model: ReturnType<typeof selectModelObservation>;
  connected: boolean;
  terminal: boolean;
  now: number;
  blockReason: string | null;
  showHistory: boolean;
  history: ReturnType<typeof useSessionHistory>;
  onClose: () => void;
}

export function SessionInfo({ session, model, connected, terminal, now, blockReason, showHistory, history, onClose }: Props) {
  const wechatHistory = hasWechatHistorySource(session);
  const metadata = [
    ["标题", session.title || "未命名会话"],
    ["机器", `${session.nodeId} · ${connected ? "在线" : "离线"}`],
    ["工作目录", session.cwd || "目录未报告"],
    ["模型", model.model || "模型未报告"],
    ["Provider", model.modelProvider || "未报告"],
    ["推理强度", model.reasoningEffort || "未报告"],
    ["模型来源", modelSourceLabel(model.source)],
    ["模型观测时间", model.observedAt ? formatTimestamp(model.observedAt) : "未报告"],
    ["会话 ID", session.id],
    ["最近更新", formatTimestamp(session.updatedAt || session.observedAt)],
  ];
  return <SessionDetails onClose={onClose}>
    <dl className="session-metadata">{metadata.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    <section className="session-info-section"><h3>{wechatHistory ? "读取说明" : "发送说明"}</h3>
      {wechatHistory ? <p>主微信 Codex 对话仅提供历史读取，控制台不会发送消息。</p> : <p>消息会发往当前会话，保留原来的模型与设置。发送状态确认前，请勿重复发送。</p>}
      {!terminal && (canResumeSession(session, now) || session.sendAvailability) && <p>{canResumeSession(session, now) ? "会话需要时会自动恢复，发送前检查是否正在使用。" : blockReason || "通过原会话发送，保留会话设置。"}</p>}
      {terminal && session.sendAvailability?.route === "terminal-pane" && <p>原终端输入 · 非原子：CLI 退出、同类进程替换或人工输入可能与投递竞态。输入已写入，执行未确认；不是任务完成，勿自动重发。</p>}
      <p>草稿只保留在当前页面，关闭页面后不会保存。</p>
    </section>
    {showHistory && <div className="history-controls"><span>{history.history ? `历史更新于 ${formatTimestamp(history.history.fetchedAt)}` : "正在准备会话历史"}</span><button type="button" onClick={() => void history.refresh()} disabled={history.loadingLatest || !history.canRead || history.contextExpired} aria-label="从详情刷新会话历史"><RefreshCw size={14} aria-hidden="true" />刷新历史</button></div>}
    {history.requestedSource === "control-socket" && <div className="detail-subline" role="status"><span>读取当前会话已保存的记录，可能稍有延迟。</span><button type="button" className="text-button" disabled={!history.canRead} onClick={() => void history.useAutomaticHistory()}>恢复自动来源</button></div>}
    {showHistory && history.history && <ExecutionTimeline items={history.history.items} source={history.history.source} gapBeforeIds={history.gapBeforeIds} now={now} />}
  </SessionDetails>;
}
