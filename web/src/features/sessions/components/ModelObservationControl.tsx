import { Bot, ChevronDown, X } from "lucide-react";
import { useId, useRef, useState } from "react";
import { formatTimestamp } from "../../../format";
import { modelSourceLabel, type selectModelObservation } from "../model-observation";
import { SessionDialog } from "./SessionDialog";

export function ModelObservationControl({ model }: { model: ReturnType<typeof selectModelObservation> }) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState({ top: 0, left: 0 });
  function show() {
    const bounds = triggerRef.current!.getBoundingClientRect();
    setAnchor({ top: Math.max(12, bounds.top - 312), left: Math.max(12, Math.min(bounds.left, window.innerWidth - 332)) });
    setOpen(true);
  }
  return <>
    <button ref={triggerRef} type="button" className="composer-model model-control" aria-label="查看模型信息" aria-haspopup="dialog" aria-expanded={open} onClick={show}><Bot size={14} aria-hidden="true" /><span>{model.model || "模型未报告"}</span>{model.reasoningEffort && <span className="composer-effort">{model.reasoningEffort}</span>}<ChevronDown size={12} aria-hidden="true" /></button>
    {open && <SessionDialog className="ui-popover-dialog model-dialog" labelledBy={titleId} onClose={() => setOpen(false)} style={{ top: anchor.top, left: anchor.left }}>
      <header className="ui-popover-header"><h2 id={titleId}>模型信息</h2><button type="button" data-dialog-close className="icon-button" aria-label="关闭模型信息" onClick={() => setOpen(false)}><X size={18} aria-hidden="true" /></button></header>
      <dl className="model-observation-rows">{[["模型", model.model || "未报告"], ["Provider", model.modelProvider || "未报告"], ["推理强度", model.reasoningEffort || "未报告"], ["来源", modelSourceLabel(model.source)], ["观测时间", model.observedAt ? formatTimestamp(model.observedAt) : "未报告"]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      <p className="ui-popover-note">当前会话的设置，只读展示。消息沿用原会话设置。</p>
    </SessionDialog>}
  </>;
}
