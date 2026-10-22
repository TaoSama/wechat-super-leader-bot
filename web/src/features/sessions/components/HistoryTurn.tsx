import { ChevronRight, TriangleAlert } from "lucide-react";
import { memo, useId, useState } from "react";
import type { HistoryTurn as Turn } from "../history-turns";
import { presentToolState } from "./tool-presentation";
import { HistoryMessage } from "./HistoryMessage";

export const HistoryTurn = memo(function HistoryTurn({ turn }: { turn: Turn }) {
  const [expansion, setExpansion] = useState<{ status: Turn["status"]; expanded: boolean } | null>(null);
  const detailsId = useId();
  const ended = turn.status === "completed" || turn.status === "failed" || turn.status === "interrupted";
  const expanded = expansion && expansion.status === turn.status ? expansion.expanded : !ended;
  const states = turn.tools.map(item => presentToolState(item.status));
  const failed = states.filter(state => state.isFailed).length;
  const unfinished = states.filter(state => state.isUnfinished && !state.isAwaitingApproval).length;
  const approval = states.filter(state => state.isAwaitingApproval).length;
  const declined = states.filter(state => state.isDeclined).length;
  const unknown = states.filter(state => state.isUnknown).length;
  const state = turn.status === "failed" ? "本轮失败" : turn.status === "interrupted" ? "本轮已中断" : ended ? "本轮已完成" : "本轮执行记录";
  const toolIds = new Map(turn.tools.map((item, index) => [item.id, `${detailsId}-${index}`]));
  return <div className="history-turn" data-history-turn={turn.key}>
    {turn.items.flatMap(item => {
      if (item.kind !== "tool") return [<HistoryMessage item={item} key={item.id} />];
      const message = expanded ? <div key={item.id} id={toolIds.get(item.id)} className="turn-tool-row"><HistoryMessage item={item} /></div> : null;
      if (item !== turn.tools[0]) return [message];
      return [<div className={`turn-tools ${expanded ? "is-expanded" : ""}`} key="tools-summary">
        <button type="button" className="turn-tools-toggle" data-history-group={turn.key} aria-expanded={expanded} aria-controls={expanded ? [...toolIds.values()].join(" ") : undefined} onClick={() => setExpansion({ status: turn.status, expanded: !expanded })}>
          <ChevronRight size={14} aria-hidden="true" className={expanded ? "is-expanded" : undefined} />
          <span>{state}<span className="turn-tools-count"> · {turn.tools.length} 项工具记录</span></span>
          {(failed > 0 || turn.status === "failed") && <span className="turn-tools-failed"><TriangleAlert size={13} aria-hidden="true" />{failed ? `${failed} 项失败` : "失败"}</span>}
          {approval > 0 && <span className="turn-tools-unfinished">{approval} 项待审批</span>}
          {declined > 0 && <span className="turn-tools-unfinished">{declined} 项已拒绝</span>}
          {unknown > 0 && <span className="turn-tools-unfinished">{unknown} 项状态未知</span>}
          {unfinished > 0 && <span className="turn-tools-unfinished">{unfinished} 项状态未完结</span>}
          <span className="turn-tools-action">{expanded ? "收起" : "展开"}</span>
        </button>
      </div>, message];
    })}
  </div>;
}, (left, right) => left.turn.key === right.turn.key && left.turn.status === right.turn.status &&
  left.turn.items.length === right.turn.items.length && left.turn.items.every((item, index) => item === right.turn.items[index]));
