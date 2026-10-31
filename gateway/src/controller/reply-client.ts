import type { ControllerMessageResponse } from "../types.js";
import type { FetchLike } from "../wechat/client.js";
import { validateImageAttachments, type ImageAttachment } from "../wechat/media-delivery.js";
import { beforeAbort } from "../runtime/abort.js";
import { RequestDiagnostics } from "../runtime/request-diagnostics.js";

export const MESSAGE_REPLY_TIMEOUT_MS = 10_000;

export class PermanentReplyUnavailableError extends Error {
  constructor(public readonly reason: "Unavailable" | "Revoked") {
    super(`Controller message reply permanently unavailable (${reason})`);
    this.name = "PermanentReplyUnavailableError";
  }
}

export function parseControllerReply(data: unknown, endpoint: string): ControllerMessageResponse {
  if (typeof data !== "object" || data === null || typeof (data as Record<string, unknown>).text !== "string") {
    throw new Error(`Controller ${endpoint} returned invalid response schema (missing string text field)`);
  }
  const record = data as Record<string, unknown>;
  let images: ImageAttachment[] | undefined;
  if (Object.hasOwn(record, "images")) {
    try { images = validateImageAttachments(record.images); }
    catch { throw new Error(`Controller ${endpoint} returned invalid response schema (image attachments)`); }
  }
  return { text: record.text as string, commandId: typeof record.commandId === "string" ? record.commandId : undefined,
    ...(images === undefined ? {} : { images }) };
}

export async function getControllerMessageReply(options: {
  baseUrl: string; token: string; fetchImpl: FetchLike; timeoutMs: number;
}, chatId: string, messageId: string): Promise<ControllerMessageResponse> {
  if (typeof chatId !== "string" || !chatId.trim() || typeof messageId !== "string" || !messageId.trim() || [".", ".."].includes(messageId)) {
    throw new Error("Invalid Controller message reply identity");
  }
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error("Controller message reply timed out")),
    Math.min(options.timeoutMs, MESSAGE_REPLY_TIMEOUT_MS));
  const diagnostics = new RequestDiagnostics("reply_get", JSON.stringify([chatId, messageId]));
  try {
    const url = `${options.baseUrl}/v1/messages/${encodeURIComponent(messageId)}/reply?chatId=${encodeURIComponent(chatId)}`;
    const response = await beforeAbort(options.fetchImpl(url, {
      method: "GET", headers: { Authorization: `Bearer ${options.token}` }, redirect: "error", signal: abort.signal,
    }), abort.signal);
    diagnostics.phase = "headers";
    diagnostics.httpStatus = response.status;
    abort.signal.throwIfAborted();
    if (response.status === 404) throw new PermanentReplyUnavailableError("Unavailable");
    if (response.status === 403) throw new PermanentReplyUnavailableError("Revoked");
    if (!response.ok) throw new Error(`Controller message reply returned HTTP ${response.status}`);
    let value: unknown;
    diagnostics.phase = "body";
    try { value = await beforeAbort(response.json(), abort.signal); }
    catch (error) {
      abort.signal.throwIfAborted();
      throw new Error("Controller message reply returned invalid response schema (JSON)", { cause: error });
    }
    abort.signal.throwIfAborted();
    diagnostics.phase = "validate";
    const reply = parseControllerReply(value, "message reply");
    diagnostics.success();
    return reply;
  } catch (error) {
    diagnostics.failure(error, 1, 1, abort.signal.aborted);
    throw error;
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}
