import { useEffect, useState } from "react";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { ArrowLeft, CalendarClock, RefreshCw } from "lucide-react";
import { changeAutomationStatus, fetchAutomationRuns } from "../../api/automations";
import { ApiAuthError } from "../../api/errors";
import { getAuthSessionSnapshot, setUnauthenticatedSession } from "../../auth/bootstrap";
import { formatTimestamp } from "../../format";
import type { AutomationStatus, ConsoleAutomation } from "./automation-contract";
import type { ConsoleAutomationRun } from "./automation-runs";

const LABELS: Record<AutomationStatus, string> = { active: "已启用", paused: "已暂停", cancelled: "已取消", completed: "已结束" };
const KIND_LABELS: Record<ConsoleAutomation["kind"], string> = { reminder: "提醒", session: "会话任务", background: "后台任务" };

function AutomationCard({ item, onOpen }: { item: ConsoleAutomation; onOpen: (item: ConsoleAutomation) => void }) {
  const [current, setCurrent] = useState(item);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [cancelConfirm, setCancelConfirm] = useState(false);
  useEffect(() => { setCurrent(item); }, [item]);

  async function change(status: "active" | "paused" | "cancelled") {
    if (busy) return;
    const requestGeneration = getAuthSessionSnapshot().generation;
    setBusy(true); setError(undefined);
    try { setCurrent(await changeAutomationStatus(current, status)); }
    catch (cause) {
      if (cause instanceof ApiAuthError) setUnauthenticatedSession("expired", requestGeneration);
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
    <div className="notification-actions">
      <button type="button" className="ui-button ghost" onClick={() => onOpen(current)}>查看执行详情</button>
    {mutable && <>
      <button type="button" className="ui-button ghost" disabled={busy} onClick={() => void change(current.status === "active" ? "paused" : "active")}>{current.status === "active" ? "暂停" : "恢复"}</button>
      <button type="button" className="ui-button ghost" disabled={busy} onClick={() => setCancelConfirm(true)}>取消任务</button>
    </>}
    </div>
    {cancelConfirm && mutable && <ConfirmDialog title={`取消任务「${current.title}」`} description={cancellationPrompt} confirmLabel="确认取消" onConfirm={() => void change("cancelled")} onClose={() => setCancelConfirm(false)} busy={busy} destructive />}
    {busy && <p role="status" className="section-description">正在保存…</p>}
    {error && <p role="alert" className="command-error">{error}</p>}
    {current.activeRunId && <p className="section-description">{current.kind === "background"
      ? "暂停只影响后续安排；取消还会停止本轮后台会话的后续检查与追问。"
      : "暂停或取消只影响后续安排；本轮结果仍会保存。"}</p>}
  </article>;
}

const RUN_LABELS: Record<ConsoleAutomationRun["status"], string> = {
  dispatching: "正在派发", running: "执行中", completed: "执行完成", failed: "执行失败",
  unknown: "结果待核验", expired: "已过期", skipped: "已跳过",
};

function runTime(value: number): string {
  return formatTimestamp(new Date(value).toISOString());
}

function AutomationDetails({ item, onBack }: { item: ConsoleAutomation; onBack: () => void }) {
  const [runs, setRuns] = useState<ConsoleAutomationRun[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  async function load(signal?: AbortSignal) {
    setLoading(true); setError(undefined);
    try {
      setRuns(await fetchAutomationRuns(item, signal));
    } catch (cause) {
      if (signal?.aborted) return;
      if (cause instanceof ApiAuthError) {
        setUnauthenticatedSession("expired");
        return;
      }
      setError(cause instanceof Error ? cause.message : "执行记录读取失败，请重试");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [item.id, item.chatId]);

  return <section className="execution-section automation-detail" aria-labelledby="automation-detail-heading">
    <div className="automation-detail-toolbar"><button type="button" className="text-button" onClick={onBack}><ArrowLeft size={16} aria-hidden="true" />返回定时任务</button>{!loading && <button type="button" className="text-button" onClick={() => void load()}><RefreshCw size={14} aria-hidden="true" />刷新记录</button>}</div>
    <div className="section-heading"><div><p className="eyebrow">SCHEDULE DETAIL</p><h2 id="automation-detail-heading">{item.title}</h2></div><CalendarClock size={22} aria-hidden="true" /></div>
    <p className="section-description">这里只展示该定时任务的执行记录；成果内容仍在工作看板的“成果交付”中单独保存。</p>
    <dl className="automation-detail-metadata"><div><dt>状态</dt><dd>{LABELS[item.status]}</dd></div><div><dt>类型</dt><dd>{KIND_LABELS[item.kind]}</dd></div><div><dt>时区</dt><dd>{item.timezone}</dd></div><div><dt>任务 ID</dt><dd>{item.id}</dd></div></dl>
    <section className="automation-runs" aria-labelledby="automation-runs-heading">
      <div className="section-heading"><div><h3 id="automation-runs-heading">执行记录 <span>{runs?.length ?? "—"}</span></h3></div></div>
      {loading && <p role="status" className="empty-panel">正在读取执行记录…</p>}
      {error && <div role="alert" className="empty-panel"><p>{error}</p><button type="button" className="ui-button ghost" onClick={() => void load()}>重试</button></div>}
      {!loading && !error && runs && !runs.length && <p className="empty-panel">这个定时任务还没有执行记录。</p>}
      {!loading && !error && runs && <div className="execution-list">{runs.map(run => <article className={`execution-card automation-run status-${run.status}`} key={run.id} data-testid={`automation-run-${run.id}`}>
        <div className="execution-summary"><strong>{RUN_LABELS[run.status]}</strong><span className={`status-badge status-${run.status === "unknown" ? "uncertain" : run.status}`}>{run.status}</span></div>
        <p className="execution-times"><time dateTime={new Date(run.scheduledAt).toISOString()}>计划 {runTime(run.scheduledAt)}</time><time dateTime={new Date(run.updatedAt).toISOString()}>更新 {runTime(run.updatedAt)}</time></p>
        {run.commandId && <p className="execution-plan-id">指令 {run.commandId}</p>}
        {run.error && <p className="execution-caution">{run.error}</p>}
        {run.result && <p className="execution-preview" aria-label="本轮结果摘要">{run.result.text.slice(0, 500)}{run.result.text.length > 500 ? "…" : ""}</p>}
      </article>)}</div>}
    </section>
  </section>;
}

export function AutomationsSection({ items }: { items: ConsoleAutomation[] }) {
  const [selected, setSelected] = useState<ConsoleAutomation | null>(null);
  if (selected) return <AutomationDetails item={selected} onBack={() => setSelected(null)} />;
  return <section className="execution-section" aria-labelledby="automations-heading">
    <div className="section-heading"><div><h2 id="automations-heading">定时任务 <span>{items.length}</span></h2></div><CalendarClock size={22} aria-hidden="true" /></div>
    <p className="section-description">在微信中描述时间与任务即可创建。任务执行与结果通知分别记录。</p>
    {!items.length ? <p className="empty-panel">暂无定时任务</p> : <div className="execution-list">{items.map(item => <AutomationCard key={item.id} item={item} onOpen={setSelected} />)}</div>}
  </section>;
}
