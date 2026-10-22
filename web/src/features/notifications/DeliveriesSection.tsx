import { useEffect, useRef, useState } from "react";
import { FileCheck2 } from "lucide-react";
import { fetchFullDelivery } from "../../api/deliveries";
import { ApiAuthError, ApiHttpError } from "../../api/errors";
import { setUnauthenticatedSession } from "../../auth/bootstrap";
import { formatTimestamp } from "../../format";
import type { ConsoleDelivery, DeliveryStatus } from "./delivery-contract";

const LABELS: Record<DeliveryStatus, string> = { preparing: "正在准备通知", ready: "等待投递", claimed: "投递处理中", waiting_for_user: "等待微信续窗", accepted: "微信接口已接受", uncertain: "投递结果待核验", superseded: "已被更新内容替代" };
const PREVIEW_CHARS = 240;

function DeliveryCard({ item }: { item: ConsoleDelivery }) {
  const [content, setContent] = useState<string>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const now = Date.now();
  const expired = item.retainedUntil <= now;
  const staleNotice = item.expiresAt <= now && ["ready", "preparing", "waiting_for_user"].includes(item.status);
  const execution = item.kind === "completed" ? "执行完成" : item.kind === "failed" ? "执行失败" : item.kind === "blocked" ? "执行需处理" : "结果已保存";

  async function load() {
    if (loading) return;
    if (content !== undefined) { setExpanded(value => !value); return; }
    const controller = new AbortController();
    request.current = controller; setLoading(true); setError(undefined);
    try { const text = await fetchFullDelivery(item.id, controller.signal); if (!controller.signal.aborted) { setContent(text); setExpanded(true); } }
    catch (cause) {
      if (controller.signal.aborted) return;
      if (cause instanceof ApiAuthError) setUnauthenticatedSession("expired");
      else setError(cause instanceof ApiHttpError && cause.statusCode === 410 ? "成果保存期已结束。" : "完整成果加载失败，可重试。");
    } finally { if (request.current === controller) { request.current = null; setLoading(false); } }
  }

  return <article className="execution-card notification-card">
    <div className="execution-summary"><strong>{item.artifact.name}</strong><span className={`status-badge status-${item.kind === "failed" ? "failed" : "completed"}`}>{execution}</span></div>
    <p className="notification-delivery-status">通知：{staleNotice ? "通知时效已过" : LABELS[item.status]}</p>
    {item.status === "waiting_for_user" && !staleNotice && <p className="section-description">在微信中发送一条消息后，继续投递已保存的成果。</p>}
    {item.status === "uncertain" && <p className="section-description">发送结果未确认，请先核验微信；完整成果保存在这里。</p>}
    {item.messages[0] && content === undefined && <p className="execution-preview" aria-label="成果摘要">{item.messages[0].slice(0, PREVIEW_CHARS)}{item.messages[0].length > PREVIEW_CHARS ? "…" : ""}</p>}
    <p className="execution-times">记录于 {formatTimestamp(new Date(item.createdAt).toISOString())}<span>成果保留至 {formatTimestamp(new Date(item.retainedUntil).toISOString())}</span></p>
    <div className="notification-actions"><button type="button" className="ui-button ghost" disabled={loading || expired} onClick={() => void load()}>{expired ? "成果保存期已结束" : loading ? "正在加载完整成果…" : expanded ? "收起完整成果" : error ? "重试加载完整成果" : "查看完整成果"}</button>
      {loading && <button type="button" className="ui-button ghost" onClick={() => { request.current?.abort(); request.current = null; setLoading(false); }}>取消加载</button>}
    </div>
    {error && <p role="alert" className="command-error">{error}</p>}
    {expanded && content !== undefined && <pre className="notification-full-content" aria-label="完整成果">{content || "成果内容为空。"}</pre>}
  </article>;
}

export function DeliveriesSection({ items }: { items: ConsoleDelivery[] }) {
  return <section className="execution-section" aria-labelledby="deliveries-heading">
    <div className="section-heading"><div><h2 id="deliveries-heading">成果交付 <span>{items.length}</span></h2></div><FileCheck2 size={22} aria-hidden="true" /></div>
    <p className="section-description">执行完成后先保存成果，再安排通知。微信投递等待或状态未确认时，也可在此读取完整内容。</p>
    {!items.length ? <p className="empty-panel">暂无已保存成果</p> : <div className="execution-list">{items.map(item => <DeliveryCard key={item.id} item={item} />)}</div>}
  </section>;
}
