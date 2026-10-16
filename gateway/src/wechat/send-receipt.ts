type SendReceiptFailure = "InvalidRet" | "RejectedRet" | "InvalidErrcode" | "RejectedErrcode" |
  "UnsupportedShape" | "InvalidMessageId" | "InvalidErrorMessage" | "UnconfirmedErrorMessage";

export class ILinkSendReceiptError extends Error {
  constructor(public readonly reason: SendReceiptFailure) {
    // Never interpolate response values: error codes and messages are untrusted data.
    super(`WeChat sendmessage failed: ${reason}`);
    this.name = "ILinkSendReceiptError";
  }
}

const SEND_RESPONSE_FIELDS = new Set(["ret", "errcode", "message_id", "errmsg"]);

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
    // Numeric IDs are only shape-checked, never used as lossless identity evidence.
    if (!(typeof id === "string" && id.trim() || typeof id === "number" && Number.isInteger(id) && id >= 0)) {
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
