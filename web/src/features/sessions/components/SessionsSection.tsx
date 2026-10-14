import React, { useState, useMemo } from "react";
import {
  TerminalSquare,
  FolderGit2,
  Eye,
  Send,
  ShieldAlert,
  Search,
  Clock,
  Cpu,
} from "lucide-react";
import { ScopedSession } from "../../../types";
import { formatTimestamp, formatRelativeAge } from "../../../format";

interface SessionsSectionProps {
  sessions: ScopedSession[];
  nodeConnectionMap: ReadonlyMap<string, boolean>;
  selectedNodeId: string | null;
}

function getSessionStatusBadge(status: string): {
  label: string;
  className: string;
} {
  const norm = status.trim().toLowerCase();
  if (norm === "running" || norm === "active" || norm === "busy" || norm === "working") {
    return {
      label: `运行中 (${status})`,
      className: "border-cyan-500/40 bg-cyan-950/60 text-cyan-300",
    };
  }
  if (norm === "idle" || norm === "ready" || norm === "completed") {
    return {
      label: `就绪 (${status})`,
      className: "border-emerald-500/40 bg-emerald-950/60 text-emerald-300",
    };
  }
  if (norm === "error" || norm === "failed" || norm === "disconnected") {
    return {
      label: `异常 (${status})`,
      className: "border-rose-500/40 bg-rose-950/60 text-rose-300",
    };
  }
  return {
    label: `状态: ${status || "unknown"}`,
    className: "border-slate-600 bg-slate-900 text-slate-300",
  };
}

export const SessionsSection: React.FC<SessionsSectionProps> = ({
  sessions,
  nodeConnectionMap,
  selectedNodeId,
}) => {
  const [searchQuery, setSearchQuery] = useState<string>("");

  const filteredSessions = useMemo(() => {
    return sessions.filter((s) => {
      if (selectedNodeId && s.nodeId !== selectedNodeId) {
        return false;
      }
      if (!searchQuery.trim()) {
        return true;
      }
      const q = searchQuery.trim().toLowerCase();
      return (
        s.id.toLowerCase().includes(q) ||
        s.nodeId.toLowerCase().includes(q) ||
        s.title.toLowerCase().includes(q) ||
        s.cwd.toLowerCase().includes(q) ||
        s.status.toLowerCase().includes(q)
      );
    });
  }, [sessions, selectedNodeId, searchQuery]);

  return (
    <section
      aria-labelledby="sessions-heading"
      className="flex flex-col gap-3"
    >
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-[#1F2937] pb-2">
        <div className="flex items-center gap-2">
          <TerminalSquare
            className="w-4 h-4 text-cyan-400"
            aria-hidden="true"
          />
          <h2
            id="sessions-heading"
            className="text-sm font-semibold uppercase tracking-normal text-[#E6EDF3]"
          >
            宿主工作区会话目录 (Scoped Sessions)
          </h2>
          <span className="px-1.5 py-0.5 text-xs font-mono rounded bg-[#141B26] border border-[#1F2937] text-[#94A3B8] tabular-nums">
            {filteredSessions.length} / {sessions.length}
          </span>
        </div>

        {/* Filter input */}
        <div className="relative w-full sm:w-64">
          <label htmlFor="session-search-input" className="sr-only">
            检索会话 ID、节点、标题或目录
          </label>
          <Search
            className="w-3.5 h-3.5 text-[#64748B] absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
            aria-hidden="true"
          />
          <input
            id="session-search-input"
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="过滤节点 / sessionId / 标题 / cwd..."
            className="w-full min-h-[38px] pl-8 pr-3 py-1 text-xs font-mono bg-[#0E131B] border border-[#2E3C51] rounded text-[#E6EDF3] placeholder-[#64748B] focus:outline-none focus:ring-2 focus:ring-[#14B8A6]"
          />
        </div>
      </div>

      {/* Contract Notice: Composite Identity & Read-Only */}
      <div className="px-3 py-2 rounded bg-[#0E131B] border border-[#1F2937] text-xs text-[#94A3B8] flex flex-wrap items-center justify-between gap-2">
        <span>
          会话唯一标识为复合键{" "}
          <code className="font-mono text-[#E6EDF3]">nodeId + sessionId</code>
          ，禁止跨节点混用 ID。
        </span>
        <span className="font-mono text-[#2DD4BF]">
          能力标识仅反映宿主机已验证的本地协议接口 (本控制台纯只读，无发送触发器)
        </span>
      </div>

      {filteredSessions.length === 0 ? (
        <div
          role="status"
          className="p-6 rounded border border-dashed border-[#2E3C51] bg-[#0E131B]/60 text-center"
        >
          <TerminalSquare
            className="w-6 h-6 text-[#64748B] mx-auto mb-2"
            aria-hidden="true"
          />
          <p className="text-sm font-medium text-[#E6EDF3]">
            未匹配到符合条件的宿主会话
          </p>
          <p className="mt-1 text-xs text-[#94A3B8]">
            {sessions.length === 0
              ? "当前尚无任何节点上报活跃 Codex 会话。"
              : "请尝试清除搜索词或取消左侧节点筛选器。"}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2.5">
          {filteredSessions.map((session) => {
            const compositeKey = `${session.nodeId}::${session.id}`;
            const nodeOnline = nodeConnectionMap.get(session.nodeId) ?? false;
            const statusBadge = getSessionStatusBadge(session.status);
            const hasRead = session.capabilities.includes("read");
            const hasSend = session.capabilities.includes("send");

            return (
              <div
                key={compositeKey}
                data-testid={`session-row-${session.nodeId}-${session.id}`}
                className="p-3.5 rounded border border-[#1F2937] bg-[#0E131B] hover:border-[#2E3C51] transition-colors flex flex-col gap-2.5"
              >
                {/* Top row: Scoped Composite Key & Status + Capabilities */}
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2 min-w-0">
                    <span
                      className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-mono font-semibold rounded border ${
                        nodeOnline
                          ? "border-[#14B8A6]/40 bg-[#14B8A6]/10 text-[#2DD4BF]"
                          : "border-rose-500/40 bg-rose-950/40 text-rose-300"
                      }`}
                      title={
                        nodeOnline
                          ? `所属节点 ${session.nodeId} 在线`
                          : `所属节点 ${session.nodeId} 当前离线`
                      }
                    >
                      <span
                        className={`w-1.5 h-1.5 rounded-full ${
                          nodeOnline ? "bg-emerald-400" : "bg-rose-400"
                        }`}
                        aria-hidden="true"
                      />
                      {session.nodeId}
                    </span>

                    <span className="text-[#64748B] font-mono text-xs">/</span>

                    <code className="px-2 py-0.5 text-xs font-mono bg-[#090C10] border border-[#1F2937] rounded text-[#E6EDF3] break-all">
                      {session.id}
                    </code>

                    <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-mono rounded bg-[#141B26] text-[#94A3B8]">
                      <Cpu className="w-3 h-3" aria-hidden="true" />
                      {session.provider || "codex-app"}
                    </span>
                  </div>

                  {/* Session Status & Proven Capabilities */}
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span
                      className={`inline-flex items-center px-2 py-0.5 text-xs font-mono font-medium rounded border ${statusBadge.className}`}
                    >
                      {statusBadge.label}
                    </span>

                    {/* Capability Badges */}
                    {hasRead && (
                      <span
                        className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-mono rounded border border-emerald-500/30 bg-emerald-950/40 text-emerald-300"
                        title="宿主机已验证支持本地读取 (read capability)"
                      >
                        <Eye className="w-3 h-3" aria-hidden="true" />
                        <span>CAP:read</span>
                      </span>
                    )}
                    {hasSend && (
                      <span
                        className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-mono rounded border border-cyan-500/30 bg-cyan-950/40 text-cyan-300"
                        title="宿主机已验证支持指令派发 (send capability，仅在状态台只读展示)"
                      >
                        <Send className="w-3 h-3" aria-hidden="true" />
                        <span>CAP:send</span>
                      </span>
                    )}
                    {!hasRead && !hasSend && (
                      <span
                        className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-mono rounded border border-amber-500/40 bg-amber-950/40 text-amber-300"
                        title="该会话未声明任何可用能力"
                      >
                        <ShieldAlert className="w-3 h-3" aria-hidden="true" />
                        <span>无声明能力 (NONE)</span>
                      </span>
                    )}
                  </div>
                </div>

                {/* Middle: Session Title */}
                <div className="text-sm font-medium text-[#E6EDF3] break-words">
                  {session.title ? (
                    session.title
                  ) : (
                    <span className="text-[#64748B] italic">
                      (未命名会话 / 无标题摘要)
                    </span>
                  )}
                </div>

                {/* Bottom: CWD & ObservedAt */}
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1.5 pt-2 border-t border-[#1F2937]/70 text-xs font-mono text-[#94A3B8]">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <FolderGit2
                      className="w-3.5 h-3.5 text-[#64748B] shrink-0"
                      aria-hidden="true"
                    />
                    <span className="truncate" title={session.cwd || "--"}>
                      {session.cwd || "(未上报工作目录 cwd)"}
                    </span>
                  </div>

                  <div className="flex items-center gap-2 shrink-0 text-[#64748B] tabular-nums">
                    <span className="inline-flex items-center gap-1">
                      <Clock className="w-3 h-3" aria-hidden="true" />
                      观测: {formatTimestamp(session.observedAt)}
                    </span>
                    <span>({formatRelativeAge(session.observedAt)})</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
};
