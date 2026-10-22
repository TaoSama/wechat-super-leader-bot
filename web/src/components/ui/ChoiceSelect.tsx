import { Check, ChevronDown, X } from "lucide-react";
import { useId, useRef, useState } from "react";
import { SessionDialog } from "../../features/sessions/components/SessionDialog";

export interface ChoiceOption { value: string; label: string; description?: string }
interface Props { label: string; value: string; options: ChoiceOption[]; onChange: (value: string) => void; className?: string }

export function ChoiceSelect({ label, value, options, onChange, className = "" }: Props) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const listId = useId();
  const selected = options.find(option => option.value === value);
  const [anchor, setAnchor] = useState({ top: 0, left: 0 });
  function show() {
    const bounds = triggerRef.current!.getBoundingClientRect();
    const width = 260;
    const gutter = 12;
    const height = Math.min(480, window.innerHeight * .7, options.length * 52 + 62);
    setAnchor({ top: Math.max(gutter, Math.min(bounds.bottom + 6, window.innerHeight - height - gutter)), left: Math.max(gutter, Math.min(bounds.left, window.innerWidth - width - gutter)) });
    setOpen(true);
  }
  function choose(next: string) { onChange(next); setOpen(false); }
  return <div className={`choice-select ${className}`}>
    <button ref={triggerRef} type="button" className="filter-select choice-trigger" role="combobox" aria-label={label} aria-expanded={open} aria-haspopup="listbox" aria-controls={open ? listId : undefined} data-value={value} onClick={() => open ? setOpen(false) : show()} onKeyDown={event => { if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); show(); } }}><span>{selected?.label ?? "请选择"}</span><ChevronDown size={14} aria-hidden="true" /></button>
    {open && <SessionDialog className="ui-popover-dialog choice-dialog" labelledBy={titleId} onClose={() => setOpen(false)} style={{ top: anchor.top, left: anchor.left }}>
      <header className="ui-popover-header"><h2 id={titleId}>{label}</h2><button type="button" data-dialog-close className="icon-button" aria-label={`关闭${label}`} onClick={() => setOpen(false)}><X size={18} aria-hidden="true" /></button></header>
      <div id={listId} role="listbox" aria-label={label} className="choice-options" onKeyDown={event => {
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='option']")];
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const direction = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
        if (direction) { event.preventDefault(); buttons[(current + direction + buttons.length) % buttons.length]?.focus(); }
        if (event.key === "Home" || event.key === "End") { event.preventDefault(); (event.key === "Home" ? buttons[0] : buttons.at(-1))?.focus(); }
        if (event.key.length === 1 && /\S/.test(event.key)) buttons.find(button => button.textContent?.toLocaleLowerCase().startsWith(event.key.toLocaleLowerCase()))?.focus();
      }}>{options.map(option => <button key={option.value} type="button" role="option" aria-selected={value === option.value} data-autofocus={value === option.value || undefined} className="choice-option" onClick={() => choose(option.value)}><span><span>{option.label}</span>{option.description && <small>{option.description}</small>}</span>{value === option.value && <Check size={16} aria-hidden="true" />}</button>)}</div>
    </SessionDialog>}
  </div>;
}
