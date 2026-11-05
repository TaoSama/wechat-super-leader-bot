import { createHash } from "node:crypto";
import { CommandError, type CommandService } from "../commands/service.js";
import type { NodeHub } from "../nodes/hub.js";
import { ConflictError, type IStore } from "../store/interface.js";
import { isTerminalSession } from "../sessions/terminal.js";
import { APPROVAL_RESULT_WAIT_MS, approvalReceiptText, findAnswerableApproval } from "../sessions/approval.js";
import type { ApprovalDecision } from "../sessions/approval-contracts.js";
import type { Session } from "../types.js";
import { LeaderDataSchema, type LeaderData } from "./contracts.js";
import type { ApprovalAttestation } from "./model/approval-authorization.js";

type ApprovalHub = Pick<NodeHub, "getNodeSession" | "isNodeConnected">;
export interface ApprovalTarget { nodeId: string; sessionId: string; requestId: string; decision: ApprovalDecision }
export interface SessionApprovalContext {
  store: Pick<IStore, "getLeaderState">;
  hub: ApprovalHub;
  commands: Pick<CommandService, "submit">;
  now: () => number;
}

/**
 * Deterministic part of the authorization: the attested decision must equal the
 * tool decision, and when a session shows several answerable requests the user's
 * own text must name the exact requestId. Returns a refusal reason or undefined.
 */
export function approvalAuthorizationFailure(userText: string, attested: ApprovalAttestation,
  session: Pick<Session, "pendingApprovals"> | null | undefined, target: Pick<ApprovalTarget, "requestId" | "decision">): string | undefined {
  if (attested === "none") return "本条消息未明确要求批准或拒绝已展示的审批请求，未提交审批决定。";
  if (attested !== target.decision) return "审批决定与本条消息的明确指令不一致，未提交审批决定。";
  const answerable = session?.pendingApprovals?.filter(approval => approval.answerable) ?? [];
  if (!answerable.some(approval => approval.requestId === target.requestId)) return "该审批请求当前未在会话中等待处理，未提交审批决定。";
  if (answerable.length > 1 && !userText.includes(target.requestId)) {
    return "该会话有多个待审批请求，请在消息中写明要处理的 requestId，未提交审批决定。";
  }
  return undefined;
}

/** One exact approval decision bound to the chat's current user message; never queued, retried or widened. */
export async function answerSessionApproval(context: SessionApprovalContext, chatId: string, data: LeaderData,
  target: ApprovalTarget, signal: AbortSignal) {
  const claim = data.inflight;
  if (!claim || claim.expiresAt <= context.now()) return { error: "本轮处理授权已失效，未提交审批决定。" };
  const session = context.hub.getNodeSession(target.nodeId, target.sessionId);
  if (!context.hub.isNodeConnected(target.nodeId) || !session) return { error: "目标会话当前不可用，未提交审批决定。" };
  if (isTerminalSession(session)) return { error: "终端会话暂不支持远程审批" };
  const approval = session.pendingApprovals?.find(item => item.requestId === target.requestId);
  if (!approval?.turnId || !findAnswerableApproval(session, approval.turnId, target.requestId)) {
    return { error: "该审批请求当前不可远程处理，未提交审批决定。" };
  }
  signal.throwIfAborted();
  const requestId = "leader_approval_" + createHash("sha256")
    .update(JSON.stringify([chatId, claim.messageId, target.nodeId, target.sessionId, approval.turnId, target.requestId])).digest("hex");
  const assertCurrentClaim = async () => {
    const current = await context.store.getLeaderState(chatId);
    const inflight = current && LeaderDataSchema.parse(current.data).inflight;
    if (!inflight || inflight.messageId !== claim.messageId || inflight.inputHash !== claim.inputHash || inflight.expiresAt <= context.now()) {
      throw new CommandError(409, "Current-turn approval authority changed");
    }
  };
  let command;
  try {
    command = await context.commands.submit({ nodeId: target.nodeId, sessionId: target.sessionId, action: "approve",
      expectedTurnId: approval.turnId, approvalRequestId: target.requestId, approvalDecision: target.decision, requestId },
    APPROVAL_RESULT_WAIT_MS, assertCurrentClaim, undefined, { type: "chat", chatId });
  } catch (error) {
    if (!(error instanceof CommandError || error instanceof ConflictError)) throw error;
    return { error: `审批决定未提交：${error.message}` };
  }
  data.commandIds.push(command.commandId);
  return { commandId: command.commandId, status: command.status, receipt: approvalReceiptText(command) };
}
