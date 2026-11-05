import { Check, LoaderCircle, ShieldQuestion, TriangleAlert } from "lucide-react";
import type { PendingApproval } from "../../../types";
import { APPROVAL_KIND_LABELS } from "../pending-approvals";
import type { useSessionApproval } from "../useSessionApproval";

interface Props {
  approvals: PendingApproval[];
  approval: ReturnType<typeof useSessionApproval>;
  connected: boolean;
}

const DETAIL_FIELDS = [["cwd", "目录"], ["grantRoot", "授权范围"], ["reason", "原因"]] as const;

export function SessionApprovals({ approvals, approval, connected }: Props) {
  if (!approvals.length) return null;
  return <section className="session-approvals" aria-label="待处理审批">
    {approvals.map(item => {
      const answer = approval.answerFor(item);
      const settled = answer?.outcome === "completed" || answer?.outcome === "uncertain";
      const disabled = !connected || !!answer?.busy || settled;
      const Icon = answer?.busy ? LoaderCircle : answer?.outcome === "completed" ? Check : TriangleAlert;
      return <article key={item.requestId} className="send-receipt approval-entry" data-testid={`approval-${item.requestId}`}>
        <span className="receipt-heading"><ShieldQuestion size={15} aria-hidden="true" />{APPROVAL_KIND_LABELS[item.kind]}</span>
        {item.command && <pre className="approval-command">{item.command}</pre>}
        {DETAIL_FIELDS.map(([field, label]) => item[field] && <p key={field}>{label}：{item[field]}</p>)}
        <p className="approval-id">请求 ID：{item.requestId}</p>
        {item.answerable && item.turnId ? <div className="approval-actions">
          <button type="button" className="ui-button primary" disabled={disabled} aria-busy={answer?.busy} onClick={() => void approval.answer(item, "accept")}>批准</button>
          <button type="button" className="ui-button secondary" disabled={disabled} aria-busy={answer?.busy} onClick={() => void approval.answer(item, "decline")}>拒绝</button>
        </div> : <p className="approval-note">需在原客户端处理</p>}
        {answer?.message && <p className={answer.outcome === "completed" ? "" : "approval-alert"} role={answer.outcome === "completed" ? "status" : "alert"}>
          <Icon size={14} aria-hidden="true" />{answer.message}</p>}
      </article>;
    })}
  </section>;
}
