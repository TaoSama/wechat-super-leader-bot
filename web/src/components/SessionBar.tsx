import React from "react";
import {
  RefreshCw,
  LogOut,
  ShieldCheck,
  Radio,
  Clock,
  LockKeyhole,
} from "lucide-react";
import { formatTimeShort } from "../format";

export interface SessionBarProps {
  isAuthenticated: boolean;
  expiresAt?: string;
  onLogout: () => void;
  onManualRefresh: () => void;
  isLoading: boolean;
  isRefreshing: boolean;
  controllerHealthy: boolean | null;
  lastUpdatedAt: Date | null;
  consecutiveFailures: number;
}

export const SessionBar: React.FC<SessionBarProps> = ({
  isAuthenticated,
  expiresAt,
  onLogout,
  onManualRefresh,
  isLoading,
  isRefreshing,
  controllerHealthy,
  lastUpdatedAt,
  consecutiveFailures,
}) => {
  const formattedExpiry = React.useMemo(() => {
    if (!expiresAt) return null;
    const d = new Date(expiresAt);
    return Number.isNaN(d.getTime()) ? null : formatTimeShort(d);
  }, [expiresAt]);

  return (
    <header className="w-full border-b border-[#1F2937] bg-[#0E131B]/95 backdrop-blur-sm sticky top-0 z-30">
      <div className="max-w-7xl mx-auto px-3 sm:px-6 py-3 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
        {/* Left: Brand & Read-Only Seal */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <div
              className="w-2.5 h-2.5 rounded-full bg-[#14B8A6] shrink-0"
              aria-hidden="true"
            />
            <h1 className="text-base sm:text-lg font-semibold tracking-normal text-[#E6EDF3] truncate">
              Super Leader 控制平面监控台
            </h1>
            <span
              className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-mono font-medium rounded border border-[#14B8A6]/40 bg-[#14B8A6]/10 text-[#2DD4BF] shrink-0"
              title="严格只读视图，禁止任何远程写操作或发送指令"
            >
              <ShieldCheck className="w-3.5 h-3.5" aria-hidden="true" />
              READ-ONLY 只读观测
            </span>
          </div>

          {/* Mobile Liveness Badge */}
          <div className="flex lg:hidden items-center gap-2 text-xs font-mono">
            <span
              className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded border ${
                controllerHealthy === true
                  ? "border-emerald-500/40 bg-emerald-950/50 text-emerald-300"
                  : controllerHealthy === false
                  ? "border-rose-500/40 bg-rose-950/50 text-rose-300"
                  : "border-slate-700 bg-slate-900 text-slate-400"
              }`}
            >
              <Radio className="w-3 h-3" aria-hidden="true" />
              {controllerHealthy === true
                ? "CORE:OK"
                : controllerHealthy === false
                ? "CORE:ERR"
                : "CORE:IDLE"}
            </span>
          </div>
        </div>

        {/* Right: Session Info & Telemetry Controls */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
          {!isAuthenticated ? (
            <div className="flex items-center gap-2 text-xs font-mono text-[#94A3B8]">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-[#2E3C51] bg-[#090C10] text-[#94A3B8]">
                <LockKeyhole className="w-3.5 h-3.5 text-amber-400" aria-hidden="true" />
                <span>未登录 · 需微信一次性链接授权</span>
              </span>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between sm:justify-end gap-2">
              {/* Desktop Liveness & Poll Metadata */}
              <div className="hidden lg:flex items-center gap-2 text-xs font-mono text-[#94A3B8] mr-1">
                <span
                  className={`inline-flex items-center gap-1.5 px-2 py-1 rounded border ${
                    controllerHealthy === true
                      ? "border-emerald-500/40 bg-emerald-950/50 text-emerald-300"
                      : controllerHealthy === false
                      ? "border-rose-500/40 bg-rose-950/50 text-rose-300"
                      : "border-slate-700 bg-slate-900 text-slate-400"
                  }`}
                >
                  <Radio className="w-3.5 h-3.5" aria-hidden="true" />
                  {controllerHealthy === true
                    ? "CONTROLLER: ONLINE"
                    : controllerHealthy === false
                    ? "CONTROLLER: DEGRADED"
                    : "CONTROLLER: PROBING"}
                </span>
                <span className="px-2 py-1 rounded bg-[#090C10] border border-[#1F2937] tabular-nums">
                  5s 轮询 | 同步: {formatTimeShort(lastUpdatedAt)}
                </span>
                {formattedExpiry && (
                  <span
                    className="inline-flex items-center gap-1 px-2 py-1 rounded bg-[#090C10] border border-[#1F2937] text-teal-300 tabular-nums"
                    title={`会话将在 ${expiresAt} 到期`}
                  >
                    <Clock className="w-3 h-3 text-teal-400" aria-hidden="true" />
                    会话至: {formattedExpiry}
                  </span>
                )}
                {consecutiveFailures > 0 && (
                  <span className="px-2 py-1 rounded bg-rose-950/70 border border-rose-500/40 text-rose-300 tabular-nums">
                    重试 #{consecutiveFailures}
                  </span>
                )}
              </div>

              {/* Mobile compact sync info */}
              <div className="flex lg:hidden items-center gap-1.5 text-xs font-mono text-[#94A3B8] tabular-nums">
                <span>同步: {formatTimeShort(lastUpdatedAt)}</span>
                {consecutiveFailures > 0 && (
                  <span className="text-rose-400">(重试 #{consecutiveFailures})</span>
                )}
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onManualRefresh}
                  disabled={isLoading || isRefreshing}
                  aria-label="立即刷新控制平面状态"
                  title="立即刷新状态 (/v1/status)"
                  className="min-h-[44px] min-w-[44px] px-3 py-1.5 inline-flex items-center justify-center gap-1.5 text-xs font-mono font-medium rounded border border-[#2E3C51] bg-[#141B26] hover:bg-[#1E293B] text-[#E6EDF3] disabled:opacity-50 transition-colors focus:outline-none focus:ring-2 focus:ring-[#14B8A6]"
                >
                  <RefreshCw
                    className={`w-4 h-4 ${
                      isLoading || isRefreshing ? "animate-spin text-[#2DD4BF]" : ""
                    }`}
                    aria-hidden="true"
                  />
                  <span>刷新</span>
                </button>

                <button
                  type="button"
                  onClick={onLogout}
                  aria-label="退出控制台登录"
                  title="退出当前 1 小时安全登录会话"
                  className="min-h-[44px] min-w-[44px] px-3 py-1.5 inline-flex items-center justify-center gap-1.5 text-xs font-mono font-medium rounded border border-rose-500/40 bg-rose-950/30 hover:bg-rose-900/50 text-rose-200 transition-colors focus:outline-none focus:ring-2 focus:ring-rose-400"
                >
                  <LogOut className="w-4 h-4" aria-hidden="true" />
                  <span>退出登录</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
};
