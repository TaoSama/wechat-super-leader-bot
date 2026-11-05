import type { CommandRecord, Session } from "../types.js";
import type { PendingApproval } from "./approval-contracts.js";

/** The exact observed request a decision may target; telemetry never authorizes by itself. */
export function findAnswerableApproval(session: Pick<Session, "pendingApprovals">, turnId: string | undefined,
  requestId: string | undefined): PendingApproval | undefined {
  if (!turnId || !requestId) return undefined;
  return session.pendingApprovals?.find(approval => approval.requestId === requestId && approval.turnId === turnId && approval.answerable);
}

// Covers the daemon's subscribe, replay wait, answer write and bounded resolution wait.
export const APPROVAL_RESULT_WAIT_MS = 15000;
const DECISION_LABEL = { accept: "批准", decline: "拒绝" } as const;

/** Receipt wording keeps the daemon's evidence: only a resolved request is reported as handled. */
export function approvalReceiptText(command: Pick<CommandRecord, "status" | "error" | "approvalDecision">): string {
  const label = command.approvalDecision ? DECISION_LABEL[command.approvalDecision] : "处理";
  switch (command.status) {
    case "completed":
      return `已提交“${label}”，原会话已关闭该审批请求。`;
    case "failed":
      return `未提交审批决定：${command.error ?? "原会话拒绝了该请求"}。`;
    case "pending":
      return `审批决定（${label}）已发出，正在确认结果；不会自动重发，请稍后查询会话状态。`;
    default:
      return "审批结果不确定，决定可能已送达原会话；不会自动重试，请稍后查询会话状态。";
  }
}

const KIND_LABEL: Record<PendingApproval["kind"], string> = {
  commandExecution: "命令执行", fileChange: "文件修改", permissions: "权限申请", userInput: "等待输入", other: "其他请求",
};

/** Compact, display-only summary for chat replies; native text was already bounded and sanitized by the daemon. */
export function describePendingApproval(approval: PendingApproval): string {
  const parts = [`${KIND_LABEL[approval.kind]}审批 requestId=${approval.requestId}`];
  if (approval.turnId) parts.push(`turnId=${approval.turnId}`);
  if (approval.command) parts.push(`命令：${approval.command}`);
  if (approval.cwd) parts.push(`目录：${approval.cwd}`);
  if (approval.grantRoot) parts.push(`申请写入：${approval.grantRoot}`);
  if (approval.reason) parts.push(`原因：${approval.reason}`);
  if (!approval.answerable) parts.push("需在原客户端处理");
  return parts.join("；");
}
