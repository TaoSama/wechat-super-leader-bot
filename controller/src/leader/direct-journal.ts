import { createHash, randomUUID } from "node:crypto";
import { CommandError } from "../commands/service.js";
import { DirectToolRejectedError } from "./direct-errors.js";
import { ConflictError, type IStore } from "../store/interface.js";
import type { DirectCall, DirectRequest, DirectToolResult } from "./direct-contracts.js";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const identifier = (kind: string, request: DirectRequest, callId?: string) =>
  `direct_${kind}_${digest([request.messageId, callId])}`;

/** Durable start and result records make an interrupted mutation non-replayable. */
export class DirectToolJournal {
  private active = new Map<string, { fingerprint: string; promise: Promise<DirectToolResult> }>();
  constructor(private readonly store: IStore, private readonly isAllowed: (chatId: string) => boolean) {}

  async bind(request: DirectRequest): Promise<void> {
    this.assertAllowed(request.chatId);
    const messageId = identifier("turn", request);
    const original = await this.store.getMessage(request.chatId, request.messageId);
    if (original && original.text !== request.text) throw new DirectToolRejectedError(409, "Message ID already bound to different user text");
    await this.store.recordMessage({ ...request, messageId, replyText: "bound", createdAt: new Date().toISOString() });
    const bound = await this.store.getMessage(request.chatId, messageId);
    if (!bound || bound.text !== request.text) throw new DirectToolRejectedError(409, "Direct tool turn is bound to different user text");
  }

  private assertAllowed(chatId: string): void {
    if (!this.isAllowed(chatId)) throw new CommandError(403, "CHAT_NOT_ALLOWED");
  }

  async call(request: DirectCall, action: () => Promise<DirectToolResult>, effectKey?: string): Promise<DirectToolResult> {
    await this.bind(request);
    const key = JSON.stringify([request.chatId, request.messageId, request.callId]);
    const authorization = { ...request.authorization,
      automationOperations: [...new Set(request.authorization.automationOperations)].sort(),
      backgroundOperations: [...new Set(request.authorization.backgroundOperations)].sort(),
      memoryOperations: [...new Set(request.authorization.memoryOperations)].sort(),
    };
    const fingerprint = digest([request.text, request.name, request.arguments, authorization, effectKey]);
    const running = this.active.get(key);
    if (running) {
      if (running.fingerprint !== fingerprint) throw new DirectToolRejectedError(409, "Tool call ID reused with different input");
      return running.promise;
    }
    const promise = this.run(request, fingerprint, action, effectKey);
    this.active.set(key, { fingerprint, promise });
    try { return await promise; }
    finally { this.active.delete(key); }
  }

  private async run(request: DirectCall, fingerprint: string, action: () => Promise<DirectToolResult>, effectKey?: string): Promise<DirectToolResult> {
    this.assertAllowed(request.chatId);
    const startId = identifier("start", request, request.callId);
    const doneId = identifier("done", request, request.callId);
    const done = await this.store.getMessage(request.chatId, doneId);
    if (done) {
      if (done.text !== fingerprint) throw new DirectToolRejectedError(409, "Tool call ID reused with different input");
      return JSON.parse(done.replyText) as DirectToolResult;
    }
    let effectDoneId: string | undefined;
    if (effectKey !== undefined) {
      const effectStartId = identifier("effect_start", request, effectKey);
      effectDoneId = identifier("effect_done", request, effectKey);
      const completedEffect = await this.store.getMessage(request.chatId, effectDoneId);
      if (completedEffect) {
        if (completedEffect.text !== fingerprint) throw new DirectToolRejectedError(409, "Tool effect key reused with different input");
        const result = JSON.parse(completedEffect.replyText) as DirectToolResult;
        // The effect result can survive a crash before this particular call result was saved.
        await this.claim(request, startId, fingerprint, true);
        await this.complete(request, doneId, fingerprint, result);
        return result;
      }
      await this.claim(request, startId, fingerprint);
      // The shared store's unique message key elects one owner across journal instances.
      await this.claim(request, effectStartId, fingerprint);
    }
    this.assertAllowed(request.chatId);
    // Mutations leave an uncertain start on error; reads have no start marker and remain retryable.
    const result = await action();
    if (effectDoneId) await this.complete(request, effectDoneId, fingerprint, result);
    await this.complete(request, doneId, fingerprint, result);
    return result;
  }

  private async claim(request: DirectRequest, messageId: string, fingerprint: string, completedEffect = false): Promise<void> {
    const owner = randomUUID();
    await this.store.recordMessage({ chatId: request.chatId, messageId, text: fingerprint,
      replyText: owner, createdAt: new Date().toISOString() });
    const started = await this.store.getMessage(request.chatId, messageId);
    if (!started || started.text !== fingerprint) throw new DirectToolRejectedError(409, "Tool call or effect key reused with different input");
    if (started.replyText !== owner && !completedEffect) {
      throw new CommandError(409, "Tool call already started; outcome is uncertain, inspect durable state instead of retrying");
    }
  }

  private async complete(request: DirectRequest, messageId: string, fingerprint: string, result: DirectToolResult): Promise<void> {
    await this.store.recordMessage({ chatId: request.chatId, messageId, text: fingerprint,
      replyText: JSON.stringify(result), createdAt: new Date().toISOString() });
    const completed = await this.store.getMessage(request.chatId, messageId);
    if (!completed || completed.text !== fingerprint) throw new ConflictError( "Tool call or effect key reused with different input");
  }
}
