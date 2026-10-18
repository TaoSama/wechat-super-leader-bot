type SendReceiptFailure = "InvalidRet" | "RejectedRet" | "InvalidErrcode" | "RejectedErrcode" |
  "UnsupportedShape" | "InvalidMessageId" | "InvalidErrorMessage" | "UnconfirmedErrorMessage" | "EmptyResponse";

export class ILinkSendReceiptError extends Error {
  constructor(public readonly reason: SendReceiptFailure) {
    // Never interpolate response values: error codes and messages are untrusted data.
    super(`WeChat sendmessage failed: ${reason}`);
    this.name = "ILinkSendReceiptError";
  }
}

const SEND_RESPONSE_FIELDS = new Set(["ret", "errcode", "message_id", "errmsg"]);
const LOSSLESS_ID_FIELDS = new Set(["message_id", "msg_id", "svr_id"]);

/** Preserve uint64 identifiers from their JSON source before numeric precision is lost. */
export function parseILinkJson(raw: string): unknown {
  return JSON.parse(raw, (key: string, value: unknown, context?: { source?: string }) => {
    if (LOSSLESS_ID_FIELDS.has(key) && typeof value === "number") {
      if (context?.source && /^(?:0|[1-9][0-9]*)$/.test(context.source)) return context.source;
      if (!Number.isSafeInteger(value)) throw new ILinkSendReceiptError("InvalidMessageId");
    }
    return value;
  });
}

/** An HTTP-success JSON object may omit its zero code; acceptance is not delivery proof. */
export function validateSendReceipt(response: Record<string, unknown>): void {
  for (const field of ["ret", "errcode"] as const) {
    if (!Object.hasOwn(response, field)) continue;
    const value = response[field];
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      throw new ILinkSendReceiptError(field === "ret" ? "InvalidRet" : "InvalidErrcode");
    }
    if (value !== 0) throw new ILinkSendReceiptError(field === "ret" ? "RejectedRet" : "RejectedErrcode");
  }
  // Unknown envelopes are not evidence of success and must not hide nested errors.
  if (Object.keys(response).some(field => !SEND_RESPONSE_FIELDS.has(field))) {
    throw new ILinkSendReceiptError("UnsupportedShape");
  }
  if (Object.hasOwn(response, "message_id")) {
    const id = response.message_id;
    if (!(typeof id === "string" && id.trim() || typeof id === "number" && Number.isSafeInteger(id) && id >= 0)) {
      throw new ILinkSendReceiptError("InvalidMessageId");
    }
  }
  if (Object.hasOwn(response, "errmsg")) {
    if (typeof response.errmsg !== "string") throw new ILinkSendReceiptError("InvalidErrorMessage");
    if (response.errmsg.trim() && response.ret !== 0 && response.errcode !== 0) {
      throw new ILinkSendReceiptError("UnconfirmedErrorMessage");
    }
  }
}
