import { useCallback, useEffect, useRef, useState } from "react";
import { ApiAuthError, ApiHttpError } from "../../api/errors";
import { answerSessionApproval } from "../../api/sessions";
import type { ApprovalDecision, CommandRecord, PendingApproval, ScopedSession } from "../../types";
import { sessionKey } from "./useSessionHistory";

export const APPROVAL_UNCERTAIN_MESSAGE = "结果不确定，请勿重复提交，稍后刷新查看";
const COMPLETED_MESSAGES: Record<ApprovalDecision, string> = {
  accept: "已批准，原会话已关闭该审批",
  decline: "已拒绝，原会话已关闭该审批",
};

export type ApprovalOutcome = "completed" | "failed" | "uncertain";
export interface ApprovalAnswer {
  busy: boolean;
  outcome?: ApprovalOutcome;
  message?: string;
}

/** Answers are keyed per session and native approval request; an unknown outcome is never retried automatically. */
export function useSessionApproval(session: ScopedSession | null, onAuthFailure: () => void) {
  const owner = session ? sessionKey(session) : "";
  const [answers, setAnswers] = useState<Record<string, ApprovalAnswer>>({});
  const controllersRef = useRef(new Map<string, AbortController>());
  const authRef = useRef(onAuthFailure);
  authRef.current = onAuthFailure;
  const keyOf = (sessionOwner: string, approvalRequestId: string) => JSON.stringify([sessionOwner, approvalRequestId]);
  const update = useCallback((key: string, answer: ApprovalAnswer) => setAnswers(previous => ({ ...previous, [key]: answer })), []);

  useEffect(() => () => {
    for (const [key, controller] of controllersRef.current) { controller.abort(); update(key, { busy: false, outcome: "uncertain", message: APPROVAL_UNCERTAIN_MESSAGE }); }
    controllersRef.current.clear();
  }, [owner, update]);

  const settle = (key: string, decision: ApprovalDecision, command: CommandRecord) => {
    if (command.status === "completed") update(key, { busy: false, outcome: "completed", message: COMPLETED_MESSAGES[decision] });
    else if (command.status === "failed") update(key, { busy: false, outcome: "failed", message: command.error ?? "审批答复未成功" });
    else update(key, { busy: false, outcome: "uncertain", message: APPROVAL_UNCERTAIN_MESSAGE });
  };

  const answer = async (approval: PendingApproval, decision: ApprovalDecision) => {
    if (!session || !approval.answerable || !approval.turnId) return;
    const key = keyOf(owner, approval.requestId);
    const prior = answers[key];
    if (controllersRef.current.has(key) || prior?.busy || prior?.outcome === "completed" || prior?.outcome === "uncertain") return;
    const controller = new AbortController();
    controllersRef.current.set(key, controller);
    update(key, { busy: true });
    try {
      const command = await answerSessionApproval(session.nodeId, session.id, approval.turnId, approval.requestId, decision, crypto.randomUUID(), controller.signal);
      if (!controller.signal.aborted) settle(key, decision, command);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ApiAuthError) { update(key, { busy: false }); authRef.current(); return; }
      // Only an explicit client rejection proves that no answer reached the native session.
      const rejected = error instanceof ApiHttpError && error.statusCode >= 400 && error.statusCode < 500;
      update(key, rejected ? { busy: false, outcome: "failed", message: `审批未提交：${error.message}` } : { busy: false, outcome: "uncertain", message: APPROVAL_UNCERTAIN_MESSAGE });
    } finally {
      if (controllersRef.current.get(key) === controller) controllersRef.current.delete(key);
    }
  };

  const answerFor = (approval: PendingApproval): ApprovalAnswer | undefined => answers[keyOf(owner, approval.requestId)];
  return { answer, answerFor };
}
