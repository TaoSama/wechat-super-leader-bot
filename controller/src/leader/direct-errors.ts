import type { ZodError } from "zod";
import { CommandError } from "../commands/service.js";

const MAX_LISTED_ISSUES = 3;

/** This invocation was deterministically refused before its business effect began. */
export class DirectToolRejectedError extends CommandError {
  /** `message` is Chinese text shown to the leader model: what was wrong and what to do next. */
  constructor(httpStatus: number, public readonly code: string, message: string) { super(httpStatus, message); }
}

/** Names the first few failing argument paths so the model can correct them. */
export function argumentIssues(error: ZodError): string {
  return error.issues.slice(0, MAX_LISTED_ISSUES)
    .map(issue => `${issue.path.length ? issue.path.join(".") : "arguments"}: ${issue.message}`).join("；");
}

export function invalidArguments(error?: ZodError): DirectToolRejectedError {
  const detail = error ? `（${argumentIssues(error)}）` : "";
  return new DirectToolRejectedError(400, "INVALID_ARGUMENTS", `参数不符合工具要求${detail}。按工具参数说明改正后再调用。`);
}

export const chatBusy = () => new DirectToolRejectedError(409, "CHAT_BUSY",
  "本聊天的上一个操作还在处理。等它的结果返回后再决定是否调用，不要立即重试。");
/**
 * The chat became busy after this call's durable start marker was written, so the journal already counts it as
 * started and will not replay it. It is reported as unknown, not as a clean refusal.
 */
export const chatBusyAfterStart = () => new CommandError(409,
  "本聊天的上一个操作还在处理，这次调用没有完成。先查询实际状态再告诉用户，不要再调一次。");
export const goalsUnavailable = () => new DirectToolRejectedError(503, "GOALS_UNAVAILABLE",
  "持续目标功能当前不可用。告诉用户现在不能创建持续目标，可以改成普通计划。");
export const discoveryChanged = () => new DirectToolRejectedError(409, "DISCOVERY_CHANGED",
  "查询期间本聊天的状态变了，查询结果没有保存。重新查询一次。");
