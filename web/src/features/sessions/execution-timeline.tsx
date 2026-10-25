import { useMemo } from "react";
import type { HistoryItem, HistorySource } from "../../types";
import { historyTurns, type HistoryTurn } from "./history-turns";
import { presentTool, presentToolState } from "./components/tool-presentation";
import { ToolMessage } from "./components/ToolMessage";

interface Props {
  items: HistoryItem[];
  source: HistorySource;
  gapBeforeIds?: string[];
  now?: number;
}

const SOURCE_LABELS: Record<HistorySource, string> = {
  "control-socket": "控制平面历史",
  "codex-desktop": "远端会话历史",
  "terminal-transcript": "终端记录",
};

const STATUS_LABELS: Record<NonNullable<HistoryTurn["status"]>, string> = {
  inProgress: "进行中",
  completed: "已完成",
  failed: "失败",
  interrupted: "已中断",
};
const MAX_TIMELINE_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

function timestampMs(item: HistoryItem): number | undefined {
  if (!item.timestamp) return undefined;
  const value = Date.parse(item.timestamp);
  return Number.isFinite(value) ? value : undefined;
}

function trustedDurationMs(item: HistoryItem): number | undefined {
  const duration = item.durationMs;
  return duration !== undefined && Number.isSafeInteger(duration) && duration > 0 && duration <= MAX_TIMELINE_DURATION_MS
    ? duration : undefined;
}

export function formatExecutionDuration(durationMs: number | undefined): string {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return "未报告";
  if (durationMs < 1000) return "<1 秒";
  if (durationMs < 60_000) return `${Math.round(durationMs / 1000)} 秒`;
  const minutes = durationMs / 60_000;
  if (minutes < 60) return `${minutes < 10 ? minutes.toFixed(1) : Math.round(minutes)} 分钟`;
  const hours = minutes / 60;
  return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)} 小时`;
}

function turnDuration(turn: HistoryTurn, now: number): number | undefined {
  const starts: number[] = [];
  const ends: number[] = [];
  for (const item of turn.items) {
    const end = timestampMs(item);
    if (end === undefined) continue;
    ends.push(end);
    const duration = trustedDurationMs(item);
    if (duration !== undefined) starts.push(end - duration);
  }
  if (!starts.length || !ends.length) return undefined;
  const start = Math.min(...starts);
  const end = turn.status === "inProgress" ? Math.max(...ends, now) : Math.max(...ends);
  const duration = end - start;
  return duration >= 0 && duration <= MAX_TIMELINE_DURATION_MS ? duration : undefined;
}

function currentStage(turn: HistoryTurn): string {
  const running = [...turn.tools].reverse().find(item => presentToolState(item.status).isRunning);
  if (running) return `工具调用：${presentTool(running).label}（运行中）`;
  if (turn.status === "inProgress") {
    const latest = turn.items.at(-1);
    if (latest?.kind === "assistant") return "生成回复";
    if (latest?.kind === "user") return "等待模型开始";
    return "执行中，等待下一条记录";
  }
  if (turn.status === "failed") return "失败收尾";
  if (turn.status === "interrupted") return "已中断";
  if (turn.status === "completed") return "已完成";
  return "等待状态确认";
}

function failureReason(turn: HistoryTurn): string | undefined {
  if (turn.status !== "failed" && turn.status !== "interrupted") return undefined;
  const failedTool = turn.tools.find(item => presentToolState(item.status).isFailed);
  if (failedTool) return `${presentTool(failedTool).label}失败`;
  return turn.status === "interrupted" ? "本轮被中断，原会话未提供更多原因" : "本轮执行失败，原会话未提供更多原因";
}

export function ExecutionTimeline({ items, source, gapBeforeIds = [], now = Date.now() }: Props) {
  const turns = useMemo(() => historyTurns(items, gapBeforeIds), [items, gapBeforeIds]);
  return <section className="execution-timeline" data-testid="execution-timeline" aria-label="执行时间线">
    <header className="execution-timeline-header">
      <div><h3>执行时间线</h3><p>按轮次查看状态、当前阶段、耗时和工具返回。</p></div>
      <span className="execution-timeline-source">{SOURCE_LABELS[source]}</span>
    </header>
    {!turns.length ? <p className="execution-timeline-empty">暂时没有可显示的执行记录</p> : <ol className="execution-timeline-list">
      {[...turns].reverse().map((turn, index) => {
        const status = turn.status;
        const reason = failureReason(turn);
        const duration = formatExecutionDuration(turnDuration(turn, now));
        return <li className={`execution-timeline-item ${status ? `status-${status}` : "status-unknown"}`} data-testid={`execution-turn-${turn.key}`} key={turn.key}>
          <div className="execution-timeline-summary">
            <span className="execution-timeline-round">第 {turns.length - index} 轮</span>
            <span className="execution-timeline-status">{status ? STATUS_LABELS[status] : "状态未知"}</span>
            <span className="execution-timeline-duration">耗时：{duration}</span>
          </div>
          <p className="execution-timeline-stage">当前阶段：{currentStage(turn)}</p>
          {reason && <p className="execution-timeline-error" role="alert">失败原因：{reason}</p>}
          {turn.tools.length > 0 && <details className="execution-timeline-tools">
            <summary>工具调用与返回 · {turn.tools.length} 项</summary>
            <div className="execution-timeline-tool-list">{turn.tools.map(item => <ToolMessage item={item} key={item.id} />)}</div>
          </details>}
        </li>;
      })}
    </ol>}
    <p className="execution-timeline-note">时间线来自当前会话可读取记录；未报告的字段会明确标为“未报告”。</p>
  </section>;
}
