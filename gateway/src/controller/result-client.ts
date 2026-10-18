import { createHash } from "node:crypto";
import { transferTimeoutMs } from "../runtime/transfer-budget.js";
import { beforeAbort } from "../runtime/abort.js";
import { validateControllerUrl } from "./client.js";
import { RESULT_FILE_BYTES, RESULT_PENDING_LIMIT, RESULT_RESPONSE_BYTES, RESULT_TIMEOUT_MS,
  parseResultDelivery, resultObject, resultUuid, type MaterializedResultDelivery, type ResultArtifact, type ResultDelivery } from "../results/contracts.js";

const RECEIPT_RETRIES = 2;
const INTEREST_CHAT_LIMIT = 1000;
export class ResultHttpError extends Error {
  constructor(readonly status: number) { super(`Controller result request HTTP ${status}`); }
}
export interface ResultClientOptions {
  controllerUrl: string; controllerToken: string; allowInsecureController?: boolean;
  /** A configured public origin may differ from the private Controller address. */
  artifactPublicOrigin?: string; fetchImpl?: typeof fetch; timeoutMs?: number; maxFileBytes?: number;
}
export class ResultClient {
  readonly baseUrl: string;
  private readonly publicOrigin: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly downloadTimeoutMs?: number;
  private readonly maxFileBytes: number;
  private readonly token: string;
  constructor(options: ResultClientOptions) {
    this.baseUrl = validateControllerUrl(options.controllerUrl, Boolean(options.allowInsecureController));
    this.token = options.controllerToken.trim();
    if (!this.token) throw new Error("Missing Controller result token");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? RESULT_TIMEOUT_MS;
    this.downloadTimeoutMs = options.timeoutMs;
    this.maxFileBytes = options.maxFileBytes ?? RESULT_FILE_BYTES;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > RESULT_TIMEOUT_MS ||
      !Number.isSafeInteger(this.maxFileBytes) || this.maxFileBytes < 1) throw new Error("Invalid result client budgets");
    const publicUrl = new URL(options.artifactPublicOrigin ?? this.baseUrl);
    if (!["https:", "http:"].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash ||
      options.artifactPublicOrigin !== undefined && publicUrl.pathname !== "/") throw new Error("Invalid result artifact public origin");
    this.publicOrigin = publicUrl.origin;
  }
  private async request(path: string, body?: Record<string, unknown>, parent?: AbortSignal, retries = 0, prefix = "/v1/deliveries"): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const abort = new AbortController(), signal = parent ? AbortSignal.any([abort.signal, parent]) : abort.signal;
      const timer = setTimeout(() => abort.abort(new Error("Controller result request timed out")), this.timeoutMs);
      try {
        signal.throwIfAborted();
        const response = await beforeAbort(this.fetchImpl(`${this.baseUrl}${prefix}${path}`, {
          method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}), redirect: "error", signal,
        }), signal);
        if (!response.ok) throw new ResultHttpError(response.status);
        const bytes = await this.readBody(response, RESULT_RESPONSE_BYTES, signal);
        const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return JSON.parse(decoded) as unknown;
      } catch (error) {
        if (attempt >= retries || parent?.aborted || error instanceof ResultHttpError && error.status < 500 ||
          error instanceof SyntaxError) throw error;
      } finally { clearTimeout(timer); abort.abort(); }
    }
  }
  private async readBody(response: Response, maxBytes: number, signal: AbortSignal, exactSize?: number): Promise<Buffer> {
    if (!response.body) throw new Error("Controller result response body missing");
    signal.throwIfAborted();
    // Artifact size is validated before this allocation; never retain chunks plus a second full concat.
    const destination = exactSize === undefined ? undefined : Buffer.allocUnsafe(exactSize);
    const reader = response.body.getReader(), chunks: Buffer[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await beforeAbort(reader.read(), signal);
        signal.throwIfAborted();
        if (part.done) return destination ? destination.subarray(0, size) : Buffer.concat(chunks, size);
        size += part.value.byteLength;
        if (size > maxBytes) throw new Error("Controller result response exceeded byte budget");
        if (destination) destination.set(part.value, size - part.value.byteLength);
        else chunks.push(Buffer.from(part.value));
      }
    } finally { reader.releaseLock(); }
  }
  async listDeliveries(chatIds: string[], signal?: AbortSignal): Promise<ResultDelivery[]> {
    if (!chatIds.length || chatIds.length > RESULT_PENDING_LIMIT || new Set(chatIds).size !== chatIds.length ||
      chatIds.some(id => typeof id !== "string" || !id.trim())) throw new Error("Invalid result chat IDs");
    const result = resultObject(await this.request("/pending", { chatIds }, signal), ["items"]);
    if (!Array.isArray(result.items) || result.items.length > RESULT_PENDING_LIMIT) throw new Error("Invalid result delivery list");
    const items = result.items.map(item => parseResultDelivery(item));
    if (new Set(items.map(item => item.id)).size !== items.length || items.some(item => !chatIds.includes(item.chatId) || item.status !== "ready")) {
      throw new Error("Controller result list identity mismatch");
    }
    return items;
  }
  async notificationInterest(signal?: AbortSignal): Promise<{ chatIds: string[]; interested: string[] }> {
    const value = resultObject(await this.request("", undefined, signal, 0, "/v1/chats/notification-interest"), ["chatIds", "interested"]);
    const valid = (raw: unknown): raw is string[] => Array.isArray(raw) && raw.length <= INTEREST_CHAT_LIMIT && new Set(raw).size === raw.length &&
      raw.every(id => typeof id === "string" && id.trim() && id.length <= 512);
    if (!valid(value.chatIds) || !valid(value.interested)) {
      throw new Error("Controller notification interest response schema invalid");
    }
    const chatIds = value.chatIds, interested = value.interested;
    if (interested.some(chat => !chatIds.includes(chat))) throw new Error("Controller notification interest response schema invalid");
    return { chatIds, interested };
  }
  private async record(path: string, id: string, body?: Record<string, unknown>, signal?: AbortSignal, materialized = false, retries = 0): Promise<ResultDelivery> {
    resultUuid(id);
    const result = resultObject(await this.request(`/${id}${path}`, body, signal, retries), ["delivery"]);
    const delivery = parseResultDelivery(result.delivery, materialized);
    if (delivery.id !== id) throw new Error("Controller result identity mismatch");
    return delivery;
  }
  getDelivery(id: string, signal?: AbortSignal): Promise<ResultDelivery> { return this.record("", id, undefined, signal); }
  async claimDelivery(id: string, attemptId: string, signal?: AbortSignal): Promise<ResultDelivery> {
    resultUuid(attemptId);
    const item = await this.record("/claim", id, { attemptId }, signal);
    if (item.status !== "claimed" || item.attemptId !== attemptId) throw new Error("Controller result claim identity mismatch");
    return item;
  }
  async materializeDelivery(id: string, attemptId: string, signal?: AbortSignal): Promise<MaterializedResultDelivery> {
    resultUuid(attemptId);
    const item = await this.record("/materialize", id, { attemptId }, signal, true);
    if (item.status !== "claimed" || item.attemptId !== attemptId) throw new Error("Controller result materialization identity mismatch");
    this.artifactUrl(item.artifact);
    return item as MaterializedResultDelivery;
  }
  async recordReceipt(id: string, attemptId: string, status: "accepted" | "uncertain", signal?: AbortSignal): Promise<ResultDelivery> {
    resultUuid(attemptId);
    if (status !== "accepted" && status !== "uncertain") throw new Error("Invalid result receipt status");
    const item = await this.record("/receipt", id, { attemptId, status }, signal, false, RECEIPT_RETRIES);
    if (item.attemptId !== attemptId || !["accepted", "uncertain"].includes(item.status) || status === "accepted" && item.status !== "accepted") {
      throw new Error("Controller result receipt identity mismatch");
    }
    return item;
  }
  async deferDelivery(id: string, attemptId: string, reason: string, submittedMessages = 0, signal?: AbortSignal): Promise<ResultDelivery> {
    resultUuid(attemptId);
    if (!reason.trim() || reason.length > 128) throw new Error("Invalid result defer reason");
    if (!Number.isSafeInteger(submittedMessages) || submittedMessages < 0) throw new Error("Invalid result submitted step count");
    const item = await this.record("/defer", id, { attemptId, reason, submittedMessages }, signal);
    if (!["waiting_for_user", "ready"].includes(item.status) || item.lastDeferredAttemptId !== attemptId || item.lastDeferReason !== reason ||
      (item.submittedMessages ?? 0) < submittedMessages) throw new Error("Controller result defer state mismatch");
    return item;
  }
  async resumeDeliveries(chatId: string, signal?: AbortSignal, generation?: string): Promise<void> {
    if (!chatId.trim()) throw new Error("Invalid result resume chat ID");
    if (generation !== undefined && (!generation || generation.length > 512)) throw new Error("Invalid result resume generation");
    const result = resultObject(await this.request("/resume", { chatId, ...(generation ? { generation } : {}) }, signal), ["resumed"]);
    if (!Number.isSafeInteger(result.resumed) || (result.resumed as number) < 0) throw new Error("Invalid result resume count");
  }
  async blockChatDeliveries(chatId: string, reason: string, signal?: AbortSignal): Promise<number> {
    if (!chatId.trim() || !reason.trim() || reason.length > 128) throw new Error("Invalid result blocked chat request");
    const result = resultObject(await this.request("/blocked", { chatId, reason }, signal), ["blocked"]);
    if (!Number.isSafeInteger(result.blocked) || (result.blocked as number) < 0) throw new Error("Invalid result blocked count");
    return result.blocked as number;
  }
  private artifactUrl(artifact: ResultArtifact): string {
    resultUuid(artifact.id);
    if (!artifact.downloadUrl) throw new Error("Result artifact download URL missing");
    const signed = new URL(artifact.downloadUrl), base = new URL(this.baseUrl);
    const expected = `/v1/result-artifacts/${artifact.id}/download`;
    if (![this.publicOrigin, base.origin].includes(signed.origin) || signed.username || signed.password || signed.hash || signed.pathname !== expected ||
      [...signed.searchParams.keys()].length !== 2 || signed.searchParams.getAll("expires").length !== 1 ||
      signed.searchParams.getAll("signature").length !== 1 || !/^\d{1,16}$/.test(signed.searchParams.get("expires") ?? "") ||
      !/^[a-f\d]{64}$/.test(signed.searchParams.get("signature") ?? "")) throw new Error("Untrusted result artifact download URL");
    const expires = Number(signed.searchParams.get("expires"));
    if (!Number.isSafeInteger(expires) || expires > artifact.expiresAt) throw new Error("Invalid result download deadline");
    // Public links are mapped to the configured Controller transport; no credentials reach their origin.
    return `${this.baseUrl}${expected}${signed.search}`;
  }
  async downloadArtifact(artifact: ResultArtifact, parent?: AbortSignal): Promise<Buffer> {
    const url = this.artifactUrl(artifact);
    if (!Number.isSafeInteger(artifact.size) || artifact.size < 1 || artifact.size > this.maxFileBytes) throw new Error("Result artifact exceeds local file budget");
    const abort = new AbortController(), signal = parent ? AbortSignal.any([abort.signal, parent]) : abort.signal;
    const timer = setTimeout(() => abort.abort(new Error("Result artifact download timed out")),
      this.downloadTimeoutMs ?? transferTimeoutMs(artifact.size, RESULT_TIMEOUT_MS));
    try {
      signal.throwIfAborted();
      const response = await beforeAbort(this.fetchImpl(url, { method: "GET", redirect: "error", signal }), signal);
      if (response.status !== 200 || response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "text/markdown") {
        throw new Error("Controller result download invalid response");
      }
      const length = response.headers.get("content-length");
      if (length !== null && (!/^\d+$/.test(length) || Number(length) !== artifact.size)) throw new Error("Controller result download length mismatch");
      const bytes = await this.readBody(response, artifact.size, signal, artifact.size);
      if (bytes.length !== artifact.size || createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) {
        throw new Error("Controller result download integrity mismatch");
      }
      return bytes;
    } finally { clearTimeout(timer); abort.abort(); }
  }
}
