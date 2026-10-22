import { useEffect, useState } from "react";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { CalendarClock } from "lucide-react";
import { changeAutomationStatus } from "../../api/automations";
import { ApiAuthError } from "../../api/errors";
import { setUnauthenticatedSession } from "../../auth/bootstrap";
import { formatTimestamp } from "../../format";
import type { AutomationStatus, ConsoleAutomation } from "./automation-contract";

const LABELS: Record<AutomationStatus, string> = { active: "已启用", paused: "已暂停", cancelled: "已取消", completed: "已结束" };
const KIND_LABELS: Record<ConsoleAutomation["kind"], string> = { reminder: "提醒", session: "会话任务", background: "后台任务" };

function AutomationCard({ item }: { item: ConsoleAutomation }) {
  const [current, setCurrent] = useState(item);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [cancelConfirm, setCancelConfirm] = useState(false);
  useEffect(() => { setCurrent(item); }, [item]);

  async function change(status: "active" | "paused" | "cancelled") {
    if (busy) return;
    setBusy(true); setError(undefined);
    try { setCurrent(await changeAutomationStatus(current, status)); }
    catch (cause) {
      if (cause instanceof ApiAuthError) setUnauthenticatedSession("expired");
      else setError(cause instanceof Error ? cause.message : "操作未确认，请刷新核验");
    } finally { setBusy(false); setCancelConfirm(false); }
  }

  const mutable = current.status === "active" || current.status === "paused";
  const cancellationPrompt = current.kind === "background"
    ? "停止后续安排，并停止后台会话的后续检查与追问？" : "停止后续安排？";
  return <article className="execution-card notification-card">
    <div className="execution-summary"><strong>{current.title}</strong><span className={`status-badge status-${current.status}`}>{LABELS[current.status]}</span></div>
    <p className="section-description">{KIND_LABELS[current.kind]} · {current.timing.type === "at" ? formatTimestamp(current.timing.at) : "定期执行"} · {current.timezone}</p>
    {current.kind === "background" && <p className="section-description">每轮独立执行；会话默认保留 24 小时，可在微信中追问或明确延期。</p>}
    <p className="execution-times">{current.status === "paused" ? "后续执行已暂停" : current.status === "active" && current.nextAt !== null ? `下次执行 ${formatTimestamp(new Date(current.nextAt).toISOString())}` : "没有后续执行安排"}{current.activeRunId && <span>本轮正在执行</span>}{current.lastOutcome && <span>上轮{current.lastOutcome === "completed" ? "执行完成" : "执行失败"}</span>}</p>
    {mutable && <div className="notification-actions">
      <button type="button" className="ui-button ghost" disabled={busy} onClick={() => void change(current.status === "active" ? "paused" : "active")}>{current.status === "active" ? "暂停" : "恢复"}</button>
      <button type="button" className="ui-button ghost" disabled={busy} onClick={() => setCancelConfirm(true)}>取消任务</button>
    </div>}
    {cancelConfirm && mutable && <ConfirmDialog title={`取消任务「${current.title}」`} description={cancellationPrompt} confirmLabel="确认取消" onConfirm={() => void change("cancelled")} onClose={() => setCancelConfirm(false)} busy={busy} destructive />}
    {busy && <p role="status" className="section-description">正在保存…</p>}
    {error && <p role="alert" className="command-error">{error}</p>}
    {current.activeRunId && <p className="section-description">{current.kind === "background"
      ? "暂停只影响后续安排；取消还会停止本轮后台会话的后续检查与追问。"
      : "暂停或取消只影响后续安排；本轮结果仍会保存。"}</p>}
  </article>;
}

export function AutomationsSection({ items }: { items: ConsoleAutomation[] }) {
  return <section className="execution-section" aria-labelledby="automations-heading">
    <div className="section-heading"><div><h2 id="automations-heading">定时任务 <span>{items.length}</span></h2></div><CalendarClock size={22} aria-hidden="true" /></div>
    <p className="section-description">在微信中描述时间与任务即可创建。任务执行与结果通知分别记录。</p>
    {!items.length ? <p className="empty-panel">暂无定时任务</p> : <div className="execution-list">{items.map(item => <AutomationCard key={item.id} item={item} />)}</div>}
  </section>;
}
