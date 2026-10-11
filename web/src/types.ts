/**
 * Super Leader Control Plane - Wire & HTTP Status Contract
 * Strictly Read-Only Telemetry Types
 */

export type ActionType = "read" | "send";

export type CommandStatus =
  | "pending"
  | "accepted"
  | "completed"
  | "failed"
  | "uncertain";

export interface NodeStatus {
  nodeId: string;
  connected: boolean;
  lastHeartbeat: string;
  sessionCount: number;
}

export interface DesktopObservation {
  status: "active" | "idle" | "unknown";
  observedAt?: string;
  availability: "available" | "unavailable";
  source: "codex-desktop";
  model?: string;
  modelProvider?: string;
  reasoningEffort?: string;
}

export type SendRoute = "control-socket" | "desktop-owner";
export interface SendAvailability {
  route: "desktop-owner";
  state: "ready" | "blocked" | "unavailable";
  observedAt: string;
  validUntil: string;
  reason?: "busy" | "preflight-rejected" | "unavailable" | "checking";
}

export interface ScopedSession {
  id: string;
  nodeId: string;
  provider: string;
  title: string;
  cwd: string;
  status: string;
  capabilities: ActionType[];
  observedAt: string;
  model?: string;
  modelProvider?: string;
  reasoningEffort?: string;
  updatedAt?: string;
  preview?: string;
  loaded?: boolean;
  desktopObservation?: DesktopObservation;
  sendAvailability?: SendAvailability;
}

export interface HistoryItem {
  id: string;
  turnId: string;
  kind: "user" | "assistant" | "tool" | "system";
  type: string;
  text: string;
  title?: string;
  status?: string;
  timestamp?: string;
  truncated?: boolean;
}

export interface SessionHistory {
  session: ScopedSession;
  historyContext: string;
  source: "control-socket" | "codex-desktop";
  items: HistoryItem[];
  nextCursor: string | null;
  fetchedAt: string;
  truncated: boolean;
}

export interface CommandRecord {
  commandId: string;
  requestId: string;
  nodeId: string;
  sessionId: string;
  action: ActionType;
  prompt?: string;
  status: CommandStatus;
  output?: string;
  error?: string;
  turnId?: string;
  sendRoute?: SendRoute;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ControlPlaneStatusResponse {
  leaderMode?: "rules" | "model" | "unknown";
  leaderModel?: string;
  nodes: NodeStatus[];
  sessions: ScopedSession[];
  commands: CommandRecord[];
  executions: ConsoleExecutions;
}

export type ExecutionStatus = "active" | "completed" | "failed" | "cancelled" | "expired";
export type ExecutionStepStatus = CommandStatus | "waiting" | "claimed" | "cancelled" | "expired";
export interface ConsoleExecutionStep {
  step: number;
  nodeId: string;
  sessionId: string;
  prompt: string;
  promptTruncated: boolean;
  dependsOn: number[];
  status: ExecutionStepStatus;
  commandId?: string;
  turnId?: string;
}
export interface ConsoleExecution {
  id: string;
  status: ExecutionStatus;
  createdAt: number;
  expiresAt: number;
  steps: ConsoleExecutionStep[];
}
export interface ConsoleExecutions {
  observedAt: number;
  limit: 12;
  hasMore: boolean;
  items: ConsoleExecution[];
}

export interface HealthResponse {
  status: string;
  timestamp: string;
}

/**
 * Semantic mapping for command lifecycle statuses.
 * Contract strictness:
 * - accepted != completed (输入已被接受，执行结果尚未确认，切勿视为已完成)
 * - uncertain (不确定，需核验，勿自动重发)
 * - pending (waiting for daemon response)
 * - completed (execution finished and output returned)
 * - failed (rejected, expired, or execution error)
 */
export interface CommandStatusSemantics {
  status: CommandStatus;
  label: string;
  shortTag: string;
  description: string;
  tone: "amber" | "cyan" | "emerald" | "rose" | "orange";
}

export const COMMAND_STATUS_SEMANTICS: Record<
  CommandStatus,
  CommandStatusSemantics
> = {
  pending: {
    status: "pending",
    label: "等待响应 (Pending)",
    shortTag: "PENDING",
    description: "指令已入队或派发，正在等待宿主守护进程响应确认",
    tone: "amber",
  },
  accepted: {
    status: "accepted",
    label: "已受理 (Accepted)",
    shortTag: "ACCEPTED",
    description: "输入已被接受，执行结果尚未确认",
    tone: "cyan",
  },
  completed: {
    status: "completed",
    label: "执行完成 (Completed)",
    shortTag: "COMPLETED",
    description: "守护进程已完成读取或执行，并返回最终输出快照",
    tone: "emerald",
  },
  failed: {
    status: "failed",
    label: "执行失败 (Failed)",
    shortTag: "FAILED",
    description: "指令校验拒绝、过期或宿主执行返回异常错误",
    tone: "rose",
  },
  uncertain: {
    status: "uncertain",
    label: "状态存疑 (Uncertain)",
    shortTag: "UNCERTAIN",
    description: "不确定，需核验，勿自动重发",
    tone: "orange",
  },
};

export const POLL_INTERVAL_MS = 5000;


export interface AuthSessionResponse {
  authenticated: boolean;
  expiresAt?: string;
  error?: string;
}

export interface AuthLogoutResponse {
  authenticated: false;
}

export type AuthReason = "invalid_link" | "expired" | "none";

export type AuthState =
  | { status: "checking" }
  | { status: "authenticated"; expiresAt?: string }
  | { status: "unauthenticated"; reason?: AuthReason };
