import type { ControllerClient } from "../controller/client.js";
import type { ControllerMessageRequest, ControllerMessageResponse } from "../types.js";

export const CONFLICT_REPLY = "这条消息的编号与已处理消息相同，但内容不同。为避免误执行，我没有处理新内容；请重新发送一条消息。";

export class ReplyEngineBackpressureError extends Error {
  constructor() { super("Codex reply storage is full; delivery must finish before new work starts"); this.name = "ReplyEngineBackpressureError"; }
}

export class ReplyEngineUnavailableError extends Error {
  constructor() { super("Codex reply is unavailable or already closed"); this.name = "ReplyEngineUnavailableError"; }
}

/** Gateway stores this fixed response under its own conflict source, not the original message journal. */
export class ReplyEngineConflictError extends Error {
  public readonly reply: ControllerMessageResponse = Object.freeze({ text: CONFLICT_REPLY });
  constructor() { super("Message identity has conflicting content"); this.name = "ReplyEngineConflictError"; }
}

export interface ReplyEngineTurnOptions {
  progress?: (text: string, updateId: string) => Promise<{ sent: boolean; reason?: string }>;
}

export interface GatewayReplyEngine {
  readonly requestBudgetMs: number;
  reply(accountId: string, request: ControllerMessageRequest,
    controller: Pick<ControllerClient, "forwardMessage">, options?: ReplyEngineTurnOptions): Promise<ControllerMessageResponse>;
  /** True means this inbound belongs to an existing query and has no separate final reply. */
  steer?(accountId: string, request: ControllerMessageRequest,
    controller: Pick<ControllerClient, "forwardMessage">): Promise<boolean>;
  getReply(accountId: string, chatId: string, messageId: string,
    controller: Pick<ControllerClient, "getMessageReply">): Promise<ControllerMessageResponse>;
  ackReply(accountId: string, chatId: string, messageId: string,
    status: "accepted" | "uncertain" | "expired"): Promise<void>;
}
