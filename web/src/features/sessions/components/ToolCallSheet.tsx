import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useId, useRef, useState, type PointerEvent } from "react";
import type { HistoryItem } from "../../../types";
import { SessionDialog } from "./SessionDialog";
import { ToolDetails } from "./ToolDetails";
import { presentTool } from "./tool-presentation";

const DRAG_SNAP_DISTANCE = 64;

export function ToolCallSheet({ item, onClose }: { item: HistoryItem; onClose: () => void }) {
  const titleId = useId();
  const [expanded, setExpanded] = useState(false);
  const [dragOffset, setDragOffset] = useState(0);
  const dragStartRef = useRef<number | null>(null);
  const presentation = presentTool(item);
  const Icon = presentation.icon;
  const ExpandIcon = expanded ? ChevronDown : ChevronUp;

  function startDrag(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    dragStartRef.current = event.clientY;
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    if (dragStartRef.current === null) return;
    setDragOffset(Math.max(0, event.clientY - dragStartRef.current));
  }

  function finishDrag(event: PointerEvent<HTMLDivElement>) {
    if (dragStartRef.current === null) return;
    const distance = event.clientY - dragStartRef.current;
    dragStartRef.current = null;
    setDragOffset(0);
    if (distance < -DRAG_SNAP_DISTANCE) setExpanded(true);
    else if (distance > DRAG_SNAP_DISTANCE) {
      if (expanded) setExpanded(false);
      else onClose();
    }
  }

  return <SessionDialog className="tool-sheet-dialog" labelledBy={titleId} onClose={onClose} expanded={expanded} style={{ transform: `translateY(${dragOffset}px)` }}>
    <div className="tool-sheet-grip" aria-hidden="true" onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={finishDrag} onPointerCancel={() => { dragStartRef.current = null; setDragOffset(0); }}><span /></div>
    <header className="tool-sheet-header"><span className="tool-sheet-title"><Icon size={20} aria-hidden="true" /><h2 id={titleId}>{presentation.label}详情</h2></span>
      <button type="button" className="icon-button" aria-label={expanded ? "收起工具详情" : "展开工具详情"} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><ExpandIcon size={20} aria-hidden="true" /></button>
      <button data-dialog-close type="button" className="icon-button" aria-label="关闭工具详情" onClick={onClose}><X size={20} aria-hidden="true" /></button>
    </header>
    <div className="tool-sheet-body"><ToolDetails item={item} /></div>
  </SessionDialog>;
}
