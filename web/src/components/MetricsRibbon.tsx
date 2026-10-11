import React from "react";
import {
  Server,
  TerminalSquare,
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
} from "lucide-react";
import { CommandRecord, ScopedSession } from "../types";
import { DerivedNodeStatus } from "../hooks/useStatusPolling";

interface MetricsRibbonProps {
  nodes: DerivedNodeStatus[];
  sessions: ScopedSession[];
  commands: CommandRecord[];
  selectedNodeId: string | null;
  onSelectNodeId: (nodeId: string | null) => void;
}

export const MetricsRibbon: React.FC<MetricsRibbonProps> = ({
  nodes,
  sessions,
  commands,
  selectedNodeId,
  onSelectNodeId,
}) => {
  const onlineNodes = nodes.filter((n) => n.connected).length;
  const offlineNodes = nodes.length - onlineNodes;

  const sendCapableSessions = sessions.filter((s) =>
    s.capabilities.includes("send")
  ).length;
  const readOnlySessions = sessions.filter(
    (s) => s.capabilities.includes("read") && !s.capabilities.includes("send")
  ).length;

  const counts = {
    pending: 0,
    accepted: 0,
    "input-written": 0,
    completed: 0,
    failed: 0,
    uncertain: 0,
  };
  for (const cmd of commands) {
    if (cmd.status in counts) {
      counts[cmd.status] += 1;
    }
  }

  return (
    <section
      aria-label="控制平面核心遥测指标汇总"
      className="w-full border-b border-[#1F2937] bg-[#0B0F17]"
    >
      <div className="max-w-7xl mx-auto px-3 sm:px-6 py-3">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-4">
          {/* Metric 1: Nodes Online / Offline */}
          <div className="p-3 rounded border border-[#1F2937] bg-[#0E131B] flex flex-col justify-between">
            <div className="flex items-center justify-between text-xs text-[#94A3B8]">
              <span className="font-medium">宿主节点 (Nodes)</span>
              <Server className="w-4 h-4 text-[#14B8A6]" aria-hidden="true" />
            </div>
            <div className="mt-2 flex items-baseline gap-2 tabular-nums">
              <span className="text-xl sm:text-2xl font-mono font-semibold text-[#E6EDF3]">
                {onlineNodes}
              </span>
              <span className="text-xs font-mono text-emerald-400">
                在线 (ONLINE)
              </span>
              <span className="text-xs font-mono text-[#64748B]">/</span>
              <span
                className={`text-xs font-mono ${
                  offlineNodes > 0 ? "text-rose-400 font-semibold" : "text-[#64748B]"
                }`}
              >
                {offlineNodes} 离线 (OFFLINE)
              </span>
            </div>
          </div>

          {/* Metric 2: Scoped Sessions */}
          <div className="p-3 rounded border border-[#1F2937] bg-[#0E131B] flex flex-col justify-between">
            <div className="flex items-center justify-between text-xs text-[#94A3B8]">
              <span className="font-medium">活动会话 (Scoped Sessions)</span>
              <TerminalSquare
                className="w-4 h-4 text-cyan-400"
                aria-hidden="true"
              />
            </div>
            <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 tabular-nums">
              <span className="text-xl sm:text-2xl font-mono font-semibold text-[#E6EDF3]">
                {sessions.length}
              </span>
              <span className="text-xs font-mono text-cyan-300">
                可读写:{sendCapableSessions}
              </span>
              <span className="text-xs font-mono text-[#94A3B8]">
                仅读:{readOnlySessions}
              </span>
            </div>
          </div>

          {/* Metric 3: Active / In-Flight Commands (Pending & Accepted != Completed) */}
          <div className="p-3 rounded border border-[#1F2937] bg-[#0E131B] flex flex-col justify-between">
            <div className="flex items-center justify-between text-xs text-[#94A3B8]">
              <span className="font-medium">进行中指令 (In-Flight)</span>
              <Clock className="w-4 h-4 text-amber-400" aria-hidden="true" />
            </div>
            <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 tabular-nums">
              <span className="text-xl sm:text-2xl font-mono font-semibold text-[#E6EDF3]">
                {counts.pending + counts.accepted}
              </span>
              <span
                className="text-xs font-mono text-amber-300"
                title="等待守护进程响应"
              >
                待响应:{counts.pending}
              </span>
              <span
                className="text-xs font-mono text-cyan-300"
                title="输入已被接受，执行结果尚未确认 (Accepted != Completed)"
              >
                已受理:{counts.accepted}
              </span>
            </div>
          </div>

          {/* Metric 4: Terminal & Uncertain Commands */}
          <div className="p-3 rounded border border-[#1F2937] bg-[#0E131B] flex flex-col justify-between">
            <div className="flex items-center justify-between text-xs text-[#94A3B8]">
              <span className="font-medium">近 50 条指令终态与存疑</span>
              {counts.uncertain > 0 || counts.failed > 0 ? (
                <AlertTriangle
                  className="w-4 h-4 text-orange-400"
                  aria-hidden="true"
                />
              ) : (
                <CheckCircle2
                  className="w-4 h-4 text-emerald-400"
                  aria-hidden="true"
                />
              )}
            </div>
            <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 tabular-nums">
              <span className="text-xs font-mono text-emerald-400">
                完成:{counts.completed}
              </span>
              <span className="text-xs font-mono text-amber-300" title="仅输入投递结束，执行未确认">
                输入已写入:{counts["input-written"]}
              </span>
              <span
                className={`text-xs font-mono ${
                  counts.failed > 0 ? "text-rose-400 font-semibold" : "text-[#64748B]"
                }`}
              >
                失败:{counts.failed}
              </span>
              <span
                className={`text-xs font-mono ${
                  counts.uncertain > 0
                    ? "text-orange-400 font-semibold"
                    : "text-[#64748B]"
                }`}
                title="不确定，需核验，勿自动重发"
              >
                存疑(Uncertain):{counts.uncertain}
              </span>
            </div>
          </div>
        </div>

        {/* Active Node Filter Indicator */}
        {selectedNodeId && (
          <div className="mt-2.5 px-3 py-1.5 rounded bg-[#141B26] border border-[#2E3C51] flex items-center justify-between text-xs">
            <div className="flex items-center gap-2 text-[#E6EDF3]">
              <Activity className="w-3.5 h-3.5 text-[#2DD4BF]" aria-hidden="true" />
              <span>
                当前按节点过滤视图：
                <code className="ml-1 px-1.5 py-0.5 rounded bg-[#090C10] font-mono text-[#2DD4BF]">
                  {selectedNodeId}
                </code>
              </span>
            </div>
            <button
              type="button"
              onClick={() => onSelectNodeId(null)}
              className="px-2 py-1 rounded text-xs font-mono text-[#94A3B8] hover:text-[#E6EDF3] hover:bg-[#1E293B] focus:outline-none focus:ring-2 focus:ring-[#14B8A6]"
            >
              清除节点筛选
            </button>
          </div>
        )}
      </div>
    </section>
  );
};
