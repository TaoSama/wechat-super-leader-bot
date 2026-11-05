import { useState } from "react";
import { Check, LoaderCircle, Square, TriangleAlert } from "lucide-react";
import { ConfirmDialog } from "../../../components/ui/ConfirmDialog";
import type { useSessionInterrupt } from "../useSessionInterrupt";

interface Props {
  interrupt: ReturnType<typeof useSessionInterrupt>;
  runningTurnId: string | null;
}

const STOP_DESCRIPTION = "仅停止该会话当前正在运行的这一轮；排队中的消息不受影响。";

export function SessionInterrupt({ interrupt, runningTurnId }: Props) {
  const [confirming, setConfirming] = useState(false);
  const request = interrupt.request;
  const status = request?.command?.status;
  const inFlight = interrupt.busy || status === "pending" && !interrupt.pollingStopped;
  const uncertain = !!request && (request.uncertain || interrupt.pollingStopped === true);
  const Icon = uncertain || status === "failed" ? TriangleAlert : status === "completed" ? Check : LoaderCircle;
  const heading = uncertain ? "停止结果待核查" : status === "completed" ? "已停止当前轮" : status === "failed" ? "停止未成功" : "正在停止当前轮…";
  if (!runningTurnId && !request) return null;
  return <div className="session-interrupt">
    {request && <div className={`send-receipt ${uncertain ? "receipt-uncertain" : status === "failed" ? "receipt-failed" : ""}`} role={uncertain || status === "failed" ? "alert" : "status"}>
      <span className="receipt-heading"><Icon size={15} aria-hidden="true" />{heading}</span>
      {interrupt.error && <p>{interrupt.error}</p>}
      {uncertain && <button type="button" disabled={interrupt.busy} onClick={() => void interrupt.interrupt(request.turnId, true)}>核查停止结果</button>}
    </div>}
    {runningTurnId && <button type="button" className="ui-button secondary interrupt-button" disabled={inFlight || uncertain}
      aria-busy={inFlight} onClick={() => setConfirming(true)}><Square size={14} aria-hidden="true" />{inFlight ? "正在停止…" : "停止当前轮"}</button>}
    {confirming && runningTurnId && <ConfirmDialog title="停止当前轮" description={STOP_DESCRIPTION} confirmLabel="确认停止" busy={interrupt.busy}
      onClose={() => setConfirming(false)} onConfirm={() => { setConfirming(false); void interrupt.interrupt(runningTurnId); }} />}
  </div>;
}
