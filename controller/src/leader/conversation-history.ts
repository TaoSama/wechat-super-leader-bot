import { z } from "zod";
import type { ModelMessage } from "./model/contracts.js";

export const MAX_HISTORY_ITEMS = 12;
const MAX_HISTORY_BYTES = 96 * 1024;
// Legacy clipping could remove a trailing high surrogate, yielding 1499 chars.
const LEGACY_CLIPPING_BOUNDARY = 1499;
export const ConversationHistorySchema = z.array(z.object({
  role: z.enum(["user", "assistant"]), content: z.string(), complete: z.boolean().optional(), confirmationFor: z.string().uuid().optional(),
  invalidatedConfirmation: z.boolean().optional(),
})).max(MAX_HISTORY_ITEMS).default([]);
export type ConversationMessage = z.infer<typeof ConversationHistorySchema>[number];

/** Keep entire turns. A missing/truncated turn must never lose only its constraints. */
export function retainConversation(history: ConversationMessage[]): ConversationMessage[] {
  let retained = history.slice(-MAX_HISTORY_ITEMS);
  while (retained.length && Buffer.byteLength(JSON.stringify(retained), "utf8") > MAX_HISTORY_BYTES) retained = retained.slice(2);
  return retained;
}

/** Keep an expiry boundary after pending is cleared, so a later affirmation cannot revive its scope. */
export function invalidateConversationPreview(history: ConversationMessage[], previewId: string): void {
  const assistants = history.filter(message => message.role === "assistant").reverse();
  const boundary = assistants.find(message => message.confirmationFor === previewId)
    ?? assistants.find(message => message.complete === true || message.complete === undefined && message.content.length < LEGACY_CLIPPING_BOUNDARY);
  if (boundary) boundary.invalidatedConfirmation = true;
}

/** Use only the contiguous suffix of complete, paired chat turns. */
export function authorizationConversation(history: readonly ConversationMessage[]): ModelMessage[] {
  let suffix: ModelMessage[] = [];
  for (let index = 0; index < history.length; index += 2) {
    const user = history[index], assistant = history[index + 1];
    if (!user || !assistant || user.role !== "user" || assistant.role !== "assistant" ||
        [user, assistant].some(item => item.invalidatedConfirmation || item.complete === false || item.complete !== true && item.content.length >= LEGACY_CLIPPING_BOUNDARY)) {
      suffix = [];
      continue;
    }
    suffix.push({ role: "user", content: user.content }, { role: "assistant", content: assistant.content });
  }
  return suffix;
}
