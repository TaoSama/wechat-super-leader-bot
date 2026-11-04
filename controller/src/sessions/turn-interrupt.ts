import type { NodeHub } from "../nodes/hub.js";
import { HISTORY_MAX_LIMIT, isValidTurnId, type CommandRecord } from "../types.js";
import { HistoryError } from "./history.js";
import { CommandError, type CommandService } from "../commands/service.js";
import { ConflictError } from "../store/interface.js";

const RUNNING_TURN_STATUS = "inProgress";
type RunningTurnHub = Pick<NodeHub, "readHistory">;
export type RunningTurnLookup =
  | { found: true; turnId: string }
  | { found: false; reason: "none" | "ambiguous" | "unavailable" };

/** Resolves the single in-progress turn from recorded history; it never guesses between turns. */
export async function findRunningTurn(hub: RunningTurnHub, nodeId: string, sessionId: string,
  signal?: AbortSignal): Promise<RunningTurnLookup> {
  let history;
  try { history = await hub.readHistory(nodeId, sessionId, { limit: HISTORY_MAX_LIMIT }, signal); }
  catch (error) {
    if (error instanceof HistoryError) return { found: false, reason: "unavailable" };
    throw error;
  }
  const running = new Set<string>();
  for (const [turnId, status] of Object.entries(history.turnStatuses ?? {})) if (status === RUNNING_TURN_STATUS) running.add(turnId);
  for (const item of history.items) if (item.turnStatus === RUNNING_TURN_STATUS) running.add(item.turnId);
  const turns = [...running].filter(isValidTurnId);
  if (turns.length === 1) return { found: true, turnId: turns[0] };
  return { found: false, reason: turns.length ? "ambiguous" : "none" };
}

export const RUNNING_TURN_FAILURES: Record<Exclude<RunningTurnLookup, { found: true }>["reason"], string> = {
  none: "未在该会话的已记录历史中发现正在运行的轮次，未发送停止请求。",
  ambiguous: "该会话存在多个看似运行中的轮次，无法确定要停止哪一轮，未发送停止请求。",
  unavailable: "暂时读取不到该会话历史，无法确认正在运行的轮次，未发送停止请求。",
};

const INTERRUPTED_TURN_STATUS = "interrupted";

/** Receipt wording keeps the daemon's evidence: only a confirmed stop is reported as stopped. */
export function interruptReceiptText(command: Pick<CommandRecord, "status" | "output" | "error">): string {
  switch (command.status) {
    case "completed":
      return command.output === INTERRUPTED_TURN_STATUS ? "已停止该会话当前正在运行的轮次；排队中的消息不受影响。"
        : `停止请求已送达，但该轮在停止前已结束（状态：${command.output ?? "未知"}）。`;
    case "failed":
      return `未停止该轮次：${command.error ?? "原会话拒绝了停止请求"}。没有其他操作被执行。`;
    case "pending":
      return "停止请求已发出，正在确认结果；请稍后查询会话状态，不会自动重发。";
    default:
      return "停止结果不确定，请求可能已送达原会话；不会自动重试，请稍后查询会话状态。";
  }
}

// Covers the daemon's pre-check, native acknowledgement and bounded stop confirmation.
export const INTERRUPT_RESULT_WAIT_MS = 15000;

/** Rules mode: resolve the single running turn, then submit one exact interrupt bound to this chat message. */
export async function interruptRunningTurn(hub: RunningTurnHub, commands: Pick<CommandService, "submit">,
  target: { chatId: string; nodeId: string; sessionId: string; requestId: string }): Promise<{ text: string; commandId?: string }> {
  const running = await findRunningTurn(hub, target.nodeId, target.sessionId);
  if (!running.found) return { text: RUNNING_TURN_FAILURES[running.reason] };
  try {
    const command = await commands.submit({ nodeId: target.nodeId, sessionId: target.sessionId, action: "interrupt",
      expectedTurnId: running.turnId, requestId: target.requestId }, INTERRUPT_RESULT_WAIT_MS, undefined, undefined,
    { type: "chat", chatId: target.chatId });
    return { text: interruptReceiptText(command), commandId: command.commandId };
  } catch (error) {
    if (!(error instanceof CommandError || error instanceof ConflictError)) throw error;
    return { text: `停止请求未发送：${error.message}` };
  }
}
