import { createHash } from "node:crypto";
import { CommandError, TERMINAL_INTERRUPT_UNSUPPORTED, type CommandService } from "../commands/service.js";
import type { NodeHub } from "../nodes/hub.js";
import { ConflictError, type IStore } from "../store/interface.js";
import { isTerminalSession } from "../sessions/terminal.js";
import { findRunningTurn, INTERRUPT_RESULT_WAIT_MS, interruptReceiptText, RUNNING_TURN_FAILURES } from "../sessions/turn-interrupt.js";
import { LeaderDataSchema, type LeaderData } from "./contracts.js";

type InterruptHub = Pick<NodeHub, "getNodeSession" | "isNodeConnected" | "readHistory">;
interface Target { nodeId: string; sessionId: string; turnId?: string }
export interface SessionInterruptContext {
  store: Pick<IStore, "getLeaderState">;
  hub: InterruptHub;
  commands: Pick<CommandService, "submit">;
  now: () => number;
}

/** One exact-turn stop request, bound to the chat's current user message; never queued or retried. */
export async function interruptSessionTurn(context: SessionInterruptContext, chatId: string, data: LeaderData,
  target: Target, signal: AbortSignal) {
  const claim = data.inflight;
  if (!claim || claim.expiresAt <= context.now()) return { error: "本轮处理授权已失效，未发送停止请求。" };
  const session = context.hub.getNodeSession(target.nodeId, target.sessionId);
  if (!context.hub.isNodeConnected(target.nodeId) || !session) return { error: "目标会话当前不可用，未发送停止请求。" };
  if (isTerminalSession(session)) return { error: TERMINAL_INTERRUPT_UNSUPPORTED };
  let turnId = target.turnId;
  if (!turnId) {
    const running = await findRunningTurn(context.hub, target.nodeId, target.sessionId, signal);
    if (!running.found) return { error: RUNNING_TURN_FAILURES[running.reason] };
    turnId = running.turnId;
  }
  signal.throwIfAborted();
  const requestId = "leader_interrupt_" + createHash("sha256")
    .update(JSON.stringify([chatId, claim.messageId, target.nodeId, target.sessionId, turnId])).digest("hex");
  const assertCurrentClaim = async () => {
    const current = await context.store.getLeaderState(chatId);
    const inflight = current && LeaderDataSchema.parse(current.data).inflight;
    if (!inflight || inflight.messageId !== claim.messageId || inflight.inputHash !== claim.inputHash || inflight.expiresAt <= context.now()) {
      throw new CommandError(409, "Current-turn interrupt authority changed");
    }
  };
  let command;
  try {
    command = await context.commands.submit({ nodeId: target.nodeId, sessionId: target.sessionId, action: "interrupt",
      expectedTurnId: turnId, requestId }, INTERRUPT_RESULT_WAIT_MS, assertCurrentClaim, undefined, { type: "chat", chatId });
  } catch (error) {
    if (!(error instanceof CommandError || error instanceof ConflictError)) throw error;
    return { error: `停止请求未发送：${error.message}` };
  }
  data.commandIds.push(command.commandId);
  return { commandId: command.commandId, status: command.status, turnId, receipt: interruptReceiptText(command) };
}
