import { useId, type ReactNode } from "react";
import { X } from "lucide-react";
import { SessionDialog } from "./SessionDialog";

interface Props { children: ReactNode; onClose: () => void }

export function SessionDetails({ children, onClose }: Props) {
  const titleId = useId();
  return <SessionDialog className="session-details-dialog" labelledBy={titleId} onClose={onClose}>
    <div className="session-details-panel">
      <span className="sheet-handle" aria-hidden="true" />
      <header className="session-details-header"><h2 id={titleId}>会话详情</h2><button data-dialog-close type="button" className="icon-button" aria-label="关闭会话详情" onClick={onClose}><X size={20} aria-hidden="true" /></button></header>
      <div className="session-details-body">{children}</div>
    </div>
  </SessionDialog>;
}
