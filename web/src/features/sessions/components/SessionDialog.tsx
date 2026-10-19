import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";

interface Props { children: ReactNode; className: string; labelledBy: string; onClose: () => void; expanded?: boolean; style?: CSSProperties }

export function SessionDialog({ children, className, labelledBy, onClose, expanded, style }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closingRef = useRef(false);

  useEffect(() => {
    const previousFocus = document.activeElement;
    const dialog = dialogRef.current!;
    const bodyOverflow = document.body.style.overflow;
    const rootOverflow = document.documentElement.style.overflow;
    closingRef.current = false;
    dialog.showModal();
    dialog.querySelector<HTMLElement>("[data-dialog-close]")?.focus({ preventScroll: true });
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    return () => {
      closingRef.current = true;
      if (dialog.open) dialog.close();
      document.body.style.overflow = bodyOverflow;
      document.documentElement.style.overflow = rootOverflow;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);

  return <dialog ref={dialogRef} className={className} style={style} aria-labelledby={labelledBy} aria-modal="true" data-expanded={expanded}
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onClose={(event) => { if (!closingRef.current && !event.currentTarget.open) onClose(); }}
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
      if (event.key !== "Tab") return;
      const elements = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex='0']")];
      const first = elements[0];
      const last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>{children}</dialog>;
}
