import type { InputReceipt } from "./types";

const RECEIPT_KEYS = ["kind", "sessionId", "requestId", "promptSHA256", "responseRevision", "observedRevision"];
export const TERMINAL_SESSION_ID = /^terminal:[A-Za-z0-9_-]{43}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROMPT_SHA256 = /^[0-9a-f]{64}$/;

export function normalizeInputReceipt(raw: unknown): InputReceipt | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).length !== RECEIPT_KEYS.length || Object.keys(value).some(key => !RECEIPT_KEYS.includes(key)) ||
      value.kind !== "terminal-input-written" || typeof value.sessionId !== "string" || !TERMINAL_SESSION_ID.test(value.sessionId) ||
      typeof value.requestId !== "string" || !UUID_V4.test(value.requestId) ||
      typeof value.promptSHA256 !== "string" || !PROMPT_SHA256.test(value.promptSHA256) ||
      typeof value.responseRevision !== "number" || !Number.isSafeInteger(value.responseRevision) || value.responseRevision < 0 ||
      typeof value.observedRevision !== "number" || !Number.isSafeInteger(value.observedRevision) || value.observedRevision < value.responseRevision) return undefined;
  return { kind: value.kind, sessionId: value.sessionId, requestId: value.requestId, promptSHA256: value.promptSHA256,
    responseRevision: value.responseRevision, observedRevision: value.observedRevision };
}
