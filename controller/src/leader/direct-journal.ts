import { createHash, randomUUID } from "node:crypto";
import { CommandError } from "../commands/service.js";
import { DirectToolRejectedError } from "./direct-errors.js";
import { ConflictError, type IStore } from "../store/interface.js";
import { LegacyDirectAuthorizationSchema, type DirectCall, type DirectRequest, type DirectToolResult } from "./direct-contracts.js";

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

const messageRebound = () => new DirectToolRejectedError(409, "MESSAGE_REBOUND",
  "这条消息的 ID 已对应另一段原文。不要重试，告诉用户这条消息无法处理，请重新发送。");
const callReused = () => new DirectToolRejectedError(409, "CALL_ID_REUSED",
  "同一个调用 ID 已用于不同的参数。不要重试，告诉用户请重新发送请求。");
const effectReused = () => new DirectToolRejectedError(409, "EFFECT_ALREADY_SUBMITTED",
  "本条消息已经用不同参数提交过同类操作。一条消息只能提交一次这类操作；先查询已提交操作的结果，再告诉用户。");

/**
 * The first fingerprint is written; the second matches records written while the attestation was hashed in, so a
 * previous-release Gateway that still sends its attestation can replay across the deploy. A replay without the
 * attestation cannot rebuild an old hash. It gets a different callId (the Gateway hashed the attestation into it) and
 * at most hits the old effect record as EFFECT_ALREADY_SUBMITTED, which tells the model to query; nothing runs twice.
 */
interface Fingerprint { current: string; legacy: string }
function fingerprintOf(request: DirectCall, effectKey?: string): Fingerprint {
  const attested = request.authorization ?? LegacyDirectAuthorizationSchema.parse(undefined);
  const authorization = { ...attested,
    automationOperations: [...new Set(attested.automationOperations)].sort(),
    backgroundOperations: [...new Set(attested.backgroundOperations)].sort(),
    memoryOperations: [...new Set(attested.memoryOperations)].sort(),
  };
  return { current: digest([request.text, request.name, request.arguments, effectKey]),
    legacy: digest([request.text, request.name, request.arguments, authorization, effectKey]) };
}
const matches = (fingerprint: Fingerprint, stored: string) => stored === fingerprint.current || stored === fingerprint.legacy;

/** Durable start and result records make an interrupted mutation non-replayable. */
export class DirectToolJournal {
  private active = new Map<string, { fingerprint: Fingerprint; promise: Promise<DirectToolResult> }>();
  constructor(private readonly store: IStore, private readonly isAllowed: (chatId: string) => boolean,
    private readonly serialize: (request: DirectCall, result: DirectToolResult) => Promise<string> = async (_request, result) => JSON.stringify(result)) {}

  async bind(request: DirectRequest): Promise<void> {
    this.assertAllowed(request.chatId);
    const messageId = identifier("turn", request);
    const original = await this.store.getMessage(request.chatId, request.messageId);
    if (original && original.text !== request.text) throw messageRebound();
    await this.store.recordMessage({ ...request, messageId, replyText: "bound", createdAt: new Date().toISOString() });
    const bound = await this.store.getMessage(request.chatId, messageId);
    if (!bound || bound.text !== request.text) throw messageRebound();
  }

  private assertAllowed(chatId: string): void {
    if (!this.isAllowed(chatId)) throw new CommandError(403, "CHAT_NOT_ALLOWED");
  }

  async call(request: DirectCall, action: () => Promise<DirectToolResult>, effectKey?: string): Promise<DirectToolResult> {
    await this.bind(request);
    const key = JSON.stringify([request.chatId, request.messageId, request.callId]);
    const fingerprint = fingerprintOf(request, effectKey);
    const running = this.active.get(key);
    if (running) {
      if (running.fingerprint.current !== fingerprint.current) throw callReused();
      return running.promise;
    }
    const promise = this.run(request, fingerprint, action, effectKey);
    this.active.set(key, { fingerprint, promise });
    try { return await promise; }
    finally { this.active.delete(key); }
  }

  private async run(request: DirectCall, fingerprint: Fingerprint, action: () => Promise<DirectToolResult>, effectKey?: string): Promise<DirectToolResult> {
    this.assertAllowed(request.chatId);
    const startId = identifier("start", request, request.callId);
    const doneId = identifier("done", request, request.callId);
    const done = await this.store.getMessage(request.chatId, doneId);
    if (done) {
      if (!matches(fingerprint, done.text)) throw callReused();
      return JSON.parse(done.replyText) as DirectToolResult;
    }
    let effectDoneId: string | undefined;
    if (effectKey !== undefined) {
      const effectStartId = identifier("effect_start", request, effectKey);
      effectDoneId = identifier("effect_done", request, effectKey);
      const completedEffect = await this.store.getMessage(request.chatId, effectDoneId);
      if (completedEffect) {
        if (!matches(fingerprint, completedEffect.text)) throw effectReused();
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

  private async claim(request: DirectRequest, messageId: string, fingerprint: Fingerprint, completedEffect = false): Promise<void> {
    const owner = randomUUID();
    await this.store.recordMessage({ chatId: request.chatId, messageId, text: fingerprint.current,
      replyText: owner, createdAt: new Date().toISOString() });
    const started = await this.store.getMessage(request.chatId, messageId);
    if (!started || !matches(fingerprint, started.text)) throw effectReused();
    if (started.replyText !== owner && !completedEffect) {
      throw new CommandError(409, "这次调用之前已经开始过。先查询实际状态再告诉用户，不要再调一次。");
    }
  }

  private async complete(request: DirectCall, messageId: string, fingerprint: Fingerprint, result: DirectToolResult): Promise<void> {
    await this.store.recordMessage({ chatId: request.chatId, messageId, text: fingerprint.current,
      replyText: await this.serialize(request, result), createdAt: new Date().toISOString() });
    const completed = await this.store.getMessage(request.chatId, messageId);
    if (!completed || !matches(fingerprint, completed.text)) throw new ConflictError("这次调用的结果记录与另一次调用冲突。先查询实际状态再告诉用户，不要再调一次。");
  }
}
