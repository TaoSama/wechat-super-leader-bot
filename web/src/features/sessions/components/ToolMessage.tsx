import { ChevronRight, TriangleAlert } from "lucide-react";
import { memo, useEffect, useId, useState, useSyncExternalStore } from "react";
import type { HistoryItem } from "../../../types";
import { MOBILE_SESSION_QUERY } from "../useSessionNavigation";
import { ToolCallSheet } from "./ToolCallSheet";
import { ToolDetails } from "./ToolDetails";
import { presentTool } from "./tool-presentation";

const COMPACT_MAX_WIDTH = 719;
const compactSubscribers = new Set<() => void>();
let compactQuery: MediaQueryList | null = null;

function getCompactQuery() {
  if (!compactQuery && typeof window.matchMedia === "function") compactQuery = window.matchMedia(MOBILE_SESSION_QUERY);
  return compactQuery;
}

function isCompact() {
  if (typeof window === "undefined") return false;
  return getCompactQuery()?.matches ?? window.innerWidth <= COMPACT_MAX_WIDTH;
}

function notifyCompactSubscribers() {
  compactSubscribers.forEach(notify => notify());
}

function subscribeCompact(notify: () => void) {
  compactSubscribers.add(notify);
  if (compactSubscribers.size === 1) {
    compactQuery = getCompactQuery();
    if (compactQuery) compactQuery.addEventListener("change", notifyCompactSubscribers);
    else window.addEventListener("resize", notifyCompactSubscribers);
  }
  return () => {
    compactSubscribers.delete(notify);
    if (compactSubscribers.size > 0) return;
    if (compactQuery) compactQuery.removeEventListener("change", notifyCompactSubscribers);
    else window.removeEventListener("resize", notifyCompactSubscribers);
    compactQuery = null;
  };
}

export const ToolMessage = memo(function ToolMessage({ item }: { item: HistoryItem }) {
  const [expandedLayout, setExpandedLayout] = useState<boolean | null>(null);
  const compact = useSyncExternalStore(subscribeCompact, isCompact, () => false);
  const expanded = expandedLayout === compact;
  useEffect(() => setExpandedLayout(null), [compact]);
  const detailId = useId();
  const summaryId = `${detailId}-summary`;
  const stateId = `${detailId}-state`;
  const presentation = presentTool(item);
  const Icon = presentation.isFailed ? TriangleAlert : presentation.icon;
  const inlineExpanded = expanded && !compact;

  return <div className={`tool-message ${inlineExpanded ? "is-expanded" : ""} ${presentation.isRunning ? "is-running" : ""} ${presentation.isFailed ? "is-failed" : ""}`} data-history-id={item.id}>
    <button type="button" className="tool-message-trigger" aria-label={`查看${presentation.label}详情`} aria-describedby={`${summaryId} ${stateId}`} aria-haspopup={compact ? "dialog" : undefined} aria-expanded={expanded} aria-controls={expanded && !compact ? detailId : undefined} onClick={(event) => { event.currentTarget.focus({ preventScroll: true }); setExpandedLayout(expanded ? null : compact); }}>
      <span className="tool-message-visual"><span className="tool-message-icon"><Icon className="tool-type-icon" size={12} aria-hidden="true" /><ChevronRight className="tool-expand-icon" size={12} aria-hidden="true" /></span>
        <span className="tool-message-label">{presentation.label}</span><span id={summaryId} className="tool-message-summary" title={presentation.summary}>{presentation.summary}</span><span id={stateId} className={presentation.isFailed ? "tool-message-state" : "sr-only"}>{presentation.stateLabel}</span>
      </span>
    </button>
    {inlineExpanded && <div id={detailId} role="region" aria-label={`${presentation.label}详情`} className="tool-inline-details"><ToolDetails item={item} /></div>}
    {expanded && compact && <ToolCallSheet item={item} onClose={() => setExpandedLayout(null)} />}
  </div>;
});
