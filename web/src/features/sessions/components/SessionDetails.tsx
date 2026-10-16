import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

interface Props { children: ReactNode; onClose: () => void }

export function SessionDetails({ children, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  useEffect(() => {
    const previous = document.activeElement;
    const dialog = dialogRef.current!;
    dialog.showModal();
    closeRef.current?.focus();
    return () => {
      if (dialog.open) dialog.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  return <dialog ref={dialogRef} className="session-details-dialog" aria-labelledby={titleId} aria-modal="true"
    onCancel={(event) => { event.preventDefault(); onClose(); }} onClose={(event) => { if (!event.currentTarget.open) onClose(); }}
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      if (event.key !== "Tab") return;
      const elements = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex='0']")];
      const first = elements[0];
      const last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
    <div className="session-details-panel">
      <header className="session-details-header"><div><p className="eyebrow">SESSION INFO</p><h2 id={titleId}>会话详情</h2></div><button ref={closeRef} type="button" className="icon-button" aria-label="关闭会话详情" onClick={onClose}><X size={20} aria-hidden="true" /></button></header>
      <div className="session-details-body">{children}</div>
    </div>
  </dialog>;
}
