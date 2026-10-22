import { Bot, Brain, Eye, Pencil, Search, SquareTerminal, Wrench } from "lucide-react";
import type { HistoryItem } from "../../../types";

const TOOL_TYPES = {
  commandExecution: { label: "命令", icon: SquareTerminal },
  shell: { label: "命令", icon: SquareTerminal },
  fileChange: { label: "文件修改", icon: Pencil },
  edit: { label: "编辑", icon: Pencil },
  write: { label: "写入", icon: Pencil },
  read: { label: "读取", icon: Eye },
  webSearch: { label: "搜索", icon: Search },
  search: { label: "搜索", icon: Search },
  fetch: { label: "网页读取", icon: Search },
  sub_agent: { label: "子代理", icon: Bot },
  thinking: { label: "思考", icon: Brain },
} as const;

const TOOL_STATES: Record<string, { label: string; tone: "running" | "failed" | "neutral"; unfinished?: boolean; approval?: boolean }> = {
  inProgress: { label: "运行中", tone: "running" },
  in_progress: { label: "运行中", tone: "running" },
  running: { label: "运行中", tone: "running" },
  executing: { label: "运行中", tone: "running" },
  pending: { label: "等待中", tone: "neutral", unfinished: true },
  waiting: { label: "等待中", tone: "neutral", unfinished: true },
  waitingForApproval: { label: "等待审批", tone: "neutral", unfinished: true, approval: true },
  requiresApproval: { label: "等待审批", tone: "neutral", unfinished: true, approval: true },
  error: { label: "失败", tone: "failed" },
  completed: { label: "已完成", tone: "neutral" },
  failed: { label: "失败", tone: "failed" },
  canceled: { label: "已取消", tone: "neutral" },
  cancelled: { label: "已取消", tone: "neutral" },
  declined: { label: "已拒绝", tone: "neutral" },
};

export function presentToolState(status?: string) {
  const state = status && Object.hasOwn(TOOL_STATES, status) ? TOOL_STATES[status] : undefined;
  return {
    stateLabel: state?.label ?? "状态未知",
    tone: state?.tone ?? "neutral",
    nativeStatus: status || "未记录",
    isRunning: state?.tone === "running",
    isFailed: state?.tone === "failed",
    isUnfinished: state?.tone === "running" || state?.unfinished === true,
    isAwaitingApproval: state?.approval === true,
    isDeclined: status === "declined",
    isUnknown: !state,
  };
}

export function presentTool(item: HistoryItem) {
  const type = Object.hasOwn(TOOL_TYPES, item.type) ? TOOL_TYPES[item.type as keyof typeof TOOL_TYPES] : { label: "工具", icon: Wrench };
  return { ...type, ...presentToolState(item.status), summary: item.title || item.type };
}
