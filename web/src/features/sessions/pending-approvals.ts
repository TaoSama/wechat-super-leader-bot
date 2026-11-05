import type { ApprovalDecision, ApprovalKind, PendingApproval } from "../../types";

export const MAX_PENDING_APPROVALS = 4;
const MAX_APPROVAL_TEXT_CHARS = 1200;
const MAX_TURN_ID_CHARS = 128;
const MAX_ITEM_ID_CHARS = 256;
export const APPROVAL_REQUEST_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const KINDS: ReadonlySet<ApprovalKind> = new Set(["commandExecution", "fileChange", "permissions", "userInput", "other"]);
export const APPROVAL_DECISIONS: ReadonlySet<ApprovalDecision> = new Set(["accept", "decline"]);

export const APPROVAL_KIND_LABELS: Record<ApprovalKind, string> = {
  commandExecution: "命令执行",
  fileChange: "文件修改",
  permissions: "权限申请",
  userInput: "等待输入",
  other: "其他请求",
};

function text(value: unknown, max = MAX_APPROVAL_TEXT_CHARS): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}

function normalizeApproval(raw: unknown): PendingApproval | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.requestId !== "string" || !APPROVAL_REQUEST_ID.test(obj.requestId)) return null;
  if (!KINDS.has(obj.kind as ApprovalKind) || typeof obj.answerable !== "boolean") return null;
  const fields = {
    turnId: text(obj.turnId, MAX_TURN_ID_CHARS), itemId: text(obj.itemId, MAX_ITEM_ID_CHARS),
    command: text(obj.command), cwd: text(obj.cwd), reason: text(obj.reason), grantRoot: text(obj.grantRoot),
    startedAt: typeof obj.startedAt === "string" && Number.isFinite(Date.parse(obj.startedAt)) ? obj.startedAt : undefined,
  };
  const approval: PendingApproval = { requestId: obj.requestId, kind: obj.kind as ApprovalKind, answerable: obj.answerable };
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) Object.assign(approval, { [key]: value });
  return approval;
}

/** Malformed entries are dropped; telemetry never blocks the rest of the session observation. */
export function normalizePendingApprovals(raw: unknown): PendingApproval[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const result: PendingApproval[] = [];
  for (const item of raw.slice(0, MAX_PENDING_APPROVALS)) {
    const approval = normalizeApproval(item);
    if (approval && !seen.has(approval.requestId)) { seen.add(approval.requestId); result.push(approval); }
  }
  return result.length ? result : undefined;
}
