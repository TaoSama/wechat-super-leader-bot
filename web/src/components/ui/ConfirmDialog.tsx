import { useId } from "react";
import { X } from "lucide-react";
import { SessionDialog } from "../../features/sessions/components/SessionDialog";

interface Props { title: string; description: string; confirmLabel: string; onConfirm: () => void; onClose: () => void; busy?: boolean; destructive?: boolean }

export function ConfirmDialog({ title, description, confirmLabel, onConfirm, onClose, busy = false, destructive = true }: Props) {
  const titleId = useId();
  return <SessionDialog className="ui-confirm-dialog" labelledBy={titleId} onClose={() => { if (!busy) onClose(); }}>
    <header className="ui-dialog-header"><h2 id={titleId}>{title}</h2><button type="button" data-dialog-close className="icon-button" aria-label={`关闭${title}`} disabled={busy} onClick={onClose}><X size={18} aria-hidden="true" /></button></header>
    <p className="ui-dialog-description">{description}</p>
    <footer className="ui-dialog-footer"><button type="button" className="ui-button secondary" disabled={busy} onClick={onClose}>保留</button><button type="button" className={`ui-button ${destructive ? "destructive" : "primary"}`} disabled={busy} aria-busy={busy} onClick={onConfirm}>{busy ? "正在保存…" : confirmLabel}</button></footer>
  </SessionDialog>;
}
