import { ControlPlaneStatusResponse, NodeStatus, ScopedSession, CommandRecord, CommandStatus, ActionType } from "../types";
import { normalizeDesktopObservation } from "../features/sessions/session-observation";
import { normalizeSendAvailability } from "../features/sessions/send-availability";
import { isTerminalHistoryTarget } from "../features/sessions/terminal-session";
import { parseConsoleExecutions } from "../features/leader/execution-contract";
import { parseConsoleGoals } from "../features/leader/goal-contract";
import { normalizeInputReceipt, TERMINAL_SESSION_ID } from "../features/sessions/input-receipt";

const VALID_COMMAND_STATUSES: ReadonlySet<CommandStatus> = new Set([
  "pending",
  "accepted",
  "input-written",
  "completed",
  "failed",
  "uncertain",
]);

function normalizeActionCapabilities(raw: unknown): ActionType[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const result: ActionType[] = [];
  for (const item of raw) {
    if ((item === "read" || item === "send") && !result.includes(item)) {
      result.push(item);
    }
  }
  return result;
}

function normalizeNode(raw: unknown): NodeStatus | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.nodeId !== "string" || obj.nodeId.trim() === "") return null;
  return {
    nodeId: obj.nodeId,
    connected: Boolean(obj.connected),
    lastHeartbeat:
      typeof obj.lastHeartbeat === "string" ? obj.lastHeartbeat : "",
    sessionCount:
      typeof obj.sessionCount === "number" && Number.isFinite(obj.sessionCount)
        ? obj.sessionCount
        : 0,
  };
}

export function normalizeSession(raw: unknown): ScopedSession | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "string" || obj.id.trim() === "") return null;
  if (typeof obj.nodeId !== "string" || obj.nodeId.trim() === "") return null;
  const provider = typeof obj.provider === "string" && obj.provider ? obj.provider : "codex-app";

  // Malformed desktop evidence must not become "absent" and bypass its veto.
  const desktopObservation = normalizeDesktopObservation(obj.desktopObservation) ??
    (obj.desktopObservation !== undefined && obj.sendAvailability !== undefined
      ? { source: "codex-desktop" as const, status: "unknown" as const, availability: "unavailable" as const }
      : undefined);
  return {
    id: obj.id,
    nodeId: obj.nodeId,
    provider,
    title: typeof obj.title === "string" ? obj.title : "",
    cwd: typeof obj.cwd === "string" ? obj.cwd : "",
    status:
      typeof obj.status === "string" && obj.status.trim() !== ""
        ? obj.status
        : "unknown",
    capabilities: normalizeActionCapabilities(obj.capabilities),
    observedAt: typeof obj.observedAt === "string" ? obj.observedAt : "",
    model: typeof obj.model === "string" ? obj.model : undefined,
    modelProvider: typeof obj.modelProvider === "string" ? obj.modelProvider : undefined,
    reasoningEffort: typeof obj.reasoningEffort === "string" ? obj.reasoningEffort : undefined,
    updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : undefined,
    preview: typeof obj.preview === "string" ? obj.preview : undefined,
    loaded: typeof obj.loaded === "boolean" ? obj.loaded : undefined,
    desktopObservation,
    sendAvailability: normalizeSendAvailability(obj.sendAvailability),
    ...(obj.historySource === "terminal-transcript" && isTerminalHistoryTarget({ id: obj.id, provider })
      ? { historySource: "terminal-transcript" as const } : {}),
  };
}

export function normalizeCommand(raw: unknown): CommandRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.commandId !== "string" || obj.commandId.trim() === "") return null;
  if (typeof obj.nodeId !== "string" || obj.nodeId.trim() === "") return null;
  if (typeof obj.sessionId !== "string" || obj.sessionId.trim() === "") return null;

  const rawStatus = obj.status as CommandStatus;
  const status: CommandStatus = VALID_COMMAND_STATUSES.has(rawStatus)
    ? rawStatus
    : "uncertain";

  const action: ActionType = obj.action === "send" ? "send" : "read";
  const inputReceipt = normalizeInputReceipt(obj.inputReceipt);
  const terminalSend = action === "send" && (obj.sendRoute === "terminal-pane" || obj.sessionId.startsWith("terminal:"));
  if (terminalSend) {
    if (obj.sendRoute !== "terminal-pane" || !TERMINAL_SESSION_ID.test(obj.sessionId) ||
        !["pending", "input-written", "failed", "uncertain"].includes(status) || obj.turnId !== undefined ||
        obj.output !== undefined && obj.output !== "") return null;
    if (status === "input-written") {
      if (!inputReceipt || inputReceipt.sessionId !== obj.sessionId || obj.error !== undefined) return null;
    } else if (obj.inputReceipt !== undefined) return null;
  } else if (status === "input-written" || obj.inputReceipt !== undefined || action === "read" && obj.sendRoute !== undefined) return null;

  return {
    commandId: obj.commandId,
    requestId: typeof obj.requestId === "string" ? obj.requestId : "",
    nodeId: obj.nodeId,
    sessionId: obj.sessionId,
    action,
    prompt: typeof obj.prompt === "string" ? obj.prompt : undefined,
    status,
    output: typeof obj.output === "string" ? obj.output : undefined,
    error: typeof obj.error === "string" ? obj.error : undefined,
    turnId: typeof obj.turnId === "string" ? obj.turnId : undefined,
    sendRoute: obj.sendRoute === "desktop-owner" || obj.sendRoute === "control-socket" || obj.sendRoute === "terminal-pane" ? obj.sendRoute : undefined,
    inputReceipt,
    expiresAt: typeof obj.expiresAt === "string" ? obj.expiresAt : "",
    createdAt: typeof obj.createdAt === "string" ? obj.createdAt : "",
    updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : "",
  };
}

export function normalizeControlPlaneStatus(raw: unknown): ControlPlaneStatusResponse {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("控制平面状态格式无效");
  }
  const data = raw as Record<string, unknown>;
  if (!Array.isArray(data.nodes) || !Array.isArray(data.sessions) || !Array.isArray(data.commands)) {
    throw new Error("控制平面状态格式无效");
  }
  const nodes = Array.isArray(data.nodes)
    ? data.nodes
        .map(normalizeNode)
        .filter((n): n is NodeStatus => n !== null)
    : [];

  const sessions = Array.isArray(data.sessions)
    ? data.sessions
        .map(normalizeSession)
        .filter((s): s is ScopedSession => s !== null)
    : [];

  const commands = Array.isArray(data.commands)
    ? data.commands
        .map(normalizeCommand)
        .filter((c): c is CommandRecord => c !== null)
    : [];

  const leaderMode = data.leaderMode === "rules" || data.leaderMode === "model" ? data.leaderMode : "unknown";
  const leaderModel = typeof data.leaderModel === "string" && data.leaderModel.trim() ? data.leaderModel : undefined;
  return { nodes, sessions, commands, leaderMode, leaderModel, executions: parseConsoleExecutions(data.executions), goals: parseConsoleGoals(data.goals) };
}
