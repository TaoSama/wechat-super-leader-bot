import type { ControllerMessageResponse } from "../types.js";
import { ReplyEngineUnavailableError } from "./contracts.js";
import { hasConsoleCredential, redactConsoleCredentials } from "./control-mcp.js";
import { MAX_REPLY_CHARS, type ReplyJournal } from "./workspace.js";

/** Keep business receipts exact while retaining analysis from other read-only results. */
export function combineReplyText(nativeText: string, receipt: string, hasQueryResults: boolean,
  consoleText?: string): string {
  if (!hasQueryResults) return receipt;
  let analysis = redactConsoleCredentials(nativeText).trim();
  if (consoleText) analysis = analysis.replaceAll(redactConsoleCredentials(consoleText), "").trim();
  const safeReceipt = redactConsoleCredentials(receipt);
  if (!analysis || safeReceipt.includes(analysis)) return receipt;
  if (safeReceipt && analysis.includes(safeReceipt)) {
    const combined = analysis.replace(safeReceipt, receipt);
    if (combined.length <= MAX_REPLY_CHARS) return combined;
    analysis = analysis.replaceAll(safeReceipt, "").trim();
  }
  const available = Math.max(0, MAX_REPLY_CHARS - receipt.length - 2);
  return [analysis.slice(0, available).trim(), receipt].filter(Boolean).join("\n\n");
}

/** Rehydrate only the verified credential segment; preserve every other durable field. */
export function restoreConsoleReply(entry: ReplyJournal[string], raw: ControllerMessageResponse): ControllerMessageResponse {
  if (entry.consoleText === undefined) return raw; // Journals written before mixed replies were supported.
  if (!entry.reply || !hasConsoleCredential(raw.text) || redactConsoleCredentials(raw.text) !== entry.consoleText) {
    throw new ReplyEngineUnavailableError();
  }
  return { ...entry.reply, text: entry.reply.text.replace(entry.consoleText, raw.text) };
}
