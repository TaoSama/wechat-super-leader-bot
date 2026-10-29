import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { WeChatAccount, GatewaySyncState, ReplyDeliveryState } from "../types.js";
import { DeliveryState } from "./delivery-state.js";
import { effectiveRemaining, type ContextPolicy } from "./context-policy.js";

export const MAX_PROCESSED_MESSAGE_KEYS = 1000;
export const MAX_REPLY_DELIVERIES = 1000;

export function resolvePath(inputPath: string): string {
  if (inputPath.startsWith("~/") || inputPath === "~") {
    return path.resolve(os.homedir(), inputPath.slice(2));
  }
  return path.resolve(inputPath);
}

export function writePrivateJsonSync(targetPath: string, data: unknown): void {
  const resolved = resolvePath(targetPath);
  const dir = path.dirname(resolved);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const tempPath = path.join(dir, `.gateway-state-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.tmp`);
  const content = JSON.stringify(data, null, 2) + "\n";
  let fd: number | null = null;
  try {
    fd = fs.openSync(tempPath, "w", 0o600);
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, resolved);
    // A prior failed checkpoint may have created ancestors, even in another process.
    // Synchronize their real paths through the root on every write before success.
    for (let directoryToSync = fs.realpathSync(dir); ; directoryToSync = path.dirname(directoryToSync)) {
      // Unsupported directory synchronization must fail the checkpoint, without a fallback.
      const directoryFd = fs.openSync(directoryToSync, "r");
      try {
        fs.fsyncSync(directoryFd);
      } finally {
        fs.closeSync(directoryFd);
      }
      if (path.dirname(directoryToSync) === directoryToSync) break;
    }
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (err: unknown) {
        const code = (err as { code?: string })?.code;
        if (code !== "EBADF") throw err;
      }
    }
    if (fs.existsSync(tempPath)) {
      try { fs.unlinkSync(tempPath); } catch (err: unknown) {
        const code = (err as { code?: string })?.code;
        if (code !== "ENOENT") throw err;
      }
    }
  }
}

export class StateManager extends DeliveryState {
  public readonly credentialsPath: string;
  public readonly statePath: string;
  public account: WeChatAccount | null = null;
  public syncBuf: string = "";
  public processedMessageKeys: string[] = [];
  public sentReplyProgress: Record<string, number> = {};
  public replyDeliveries: Record<string, ReplyDeliveryState> = {};
  public baselineEstablished: boolean = false;
  public baselineInProgress: boolean = false;
  public baselineEstablishedAt: string | undefined = undefined;
  private processedMessageKeySet: Set<string> = new Set();
  private replyEvidenceProtection: (key: string) => boolean = () => false;

  public setReplyEvidenceProtection(protect: (key: string) => boolean): void { this.replyEvidenceProtection = protect; }

  public remainingSendBudget(chatId: string): number {
    const budget = this.contextBudgets[chatId];
    return budget && this.canSendToChat(chatId) ? effectiveRemaining(budget, this.policy) : 0;
  }

  constructor(credentialsPath: string, statePath?: string, policy: Partial<ContextPolicy> = {}) {
    super(policy);
    this.credentialsPath = resolvePath(credentialsPath);
    this.statePath = statePath ? resolvePath(statePath) : `${this.credentialsPath}.gateway.state.json`;
    this.loadAccount();
    this.loadState();
  }

  public loadAccount(): WeChatAccount | null {
    if (!fs.existsSync(this.credentialsPath)) {
      this.account = null;
      return null;
    }
    try {
      const raw = fs.readFileSync(this.credentialsPath, "utf8");
      const parsed = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) {
        throw new Error(`WeChat credentials at ${this.credentialsPath} must be a JSON object`);
      }
      if (typeof parsed.token !== "string" || !parsed.token.trim()) {
        throw new Error(`WeChat credentials at ${this.credentialsPath} missing required token`);
      }
      this.account = {
        token: parsed.token,
        accountId: typeof parsed.accountId === "string" ? parsed.accountId : "",
        baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : undefined,
        userId: typeof parsed.userId === "string" ? parsed.userId : undefined,
        savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : undefined,
      };
      return this.account;
    } catch (err) {
      // Never interpolate err.message or JSON.parse output which may leak raw token snippets
      const errType = err instanceof SyntaxError ? "InvalidJsonSyntax" : (err as Error)?.name || "ReadError";
      throw new Error(`Failed to load valid WeChat credentials from ${this.credentialsPath}: ${errType}`);
    }
  }

  public getLoginFingerprint(): string {
    if (!this.account) return "";
    const identity = JSON.stringify([this.account.accountId, this.account.token]);
    return crypto.createHash("sha256").update(identity, "utf8").digest("hex");
  }

  public loadState(): void {
    if (!fs.existsSync(this.statePath)) {
      return;
    }
    try {
      const raw = fs.readFileSync(this.statePath, "utf8");
      const state = JSON.parse(raw) as GatewaySyncState;
      if (typeof state !== "object" || state === null) {
        throw new Error(`Gateway state at ${this.statePath} must be a JSON object`);
      }
      if (state.login_fingerprint && state.login_fingerprint !== this.getLoginFingerprint()) {
        this.syncBuf = "";
        this.contextTokens = {};
        this.processedMessageKeys = [];
        this.processedMessageKeySet = new Set();
        this.sentReplyProgress = {};
        this.replyDeliveries = {};
        this.contextBudgets = {};
        this.inboundWatermarks = {};
        this.outbox = {};
        this.baselineEstablished = false;
        this.baselineInProgress = false;
        this.baselineEstablishedAt = undefined;
        return;
      }
      this.syncBuf = typeof state.sync_buf === "string" ? state.sync_buf : "";
      this.contextTokens = {};
      if (state.context_tokens && typeof state.context_tokens === "object") {
        for (const [k, v] of Object.entries(state.context_tokens)) {
          if (typeof v === "string" && v) {
            this.contextTokens[k] = v;
          }
        }
      }
      if (Array.isArray(state.processed_message_keys)) {
        this.processedMessageKeys = state.processed_message_keys
          .filter((item): item is string => typeof item === "string" && item.length > 0)
          .slice(-MAX_PROCESSED_MESSAGE_KEYS);
        this.processedMessageKeySet = new Set(this.processedMessageKeys);
      }
      this.sentReplyProgress = {};
      if (state.sent_reply_progress && typeof state.sent_reply_progress === "object") {
        for (const [k, v] of Object.entries(state.sent_reply_progress)) {
          if (typeof v === "number" && Number.isSafeInteger(v) && v > 0) {
            this.sentReplyProgress[k] = v;
          }
        }
      }
      this.baselineEstablished = state.baseline_established === true;
      this.restoreDeliveryState(state);
      this.replyDeliveries = {};
      if (state.reply_deliveries !== undefined) {
        if (!state.reply_deliveries || typeof state.reply_deliveries !== "object" || Array.isArray(state.reply_deliveries)) {
          throw new Error("Invalid reply delivery state");
        }
        for (const [key, item] of Object.entries(state.reply_deliveries)) {
          if (!item || typeof item !== "object" || !/^[a-f0-9]{64}$/.test(item.digest) ||
              !Number.isSafeInteger(item.totalChunks) || item.totalChunks <= 0 ||
              !Number.isSafeInteger(item.acknowledgedChunks) || item.acknowledgedChunks < 0 ||
              item.acknowledgedChunks > item.totalChunks || typeof item.inFlight !== "boolean" ||
              item.inFlight && item.acknowledgedChunks === item.totalChunks ||
              item.failureReason !== undefined &&
                (!["AttachmentExpired", "AttachmentUnavailable"].includes(item.failureReason) ||
                 item.inFlight || item.acknowledgedChunks === item.totalChunks)) {
            throw new Error("Invalid reply delivery state");
          }
          this.replyDeliveries[key] = { ...item };
        }
        if (Object.keys(this.replyDeliveries).length > MAX_REPLY_DELIVERIES) {
          throw new Error("Reply delivery state exceeds capacity");
        }
      }
      this.baselineInProgress = state.baseline_in_progress === true && !this.baselineEstablished;
      this.baselineEstablishedAt =
        typeof state.baseline_established_at === "string" && state.baseline_established_at
          ? state.baseline_established_at
          : undefined;
    } catch (err) {
      // Never interpolate raw err.message or JSON.parse output which may leak context tokens
      const errType = err instanceof SyntaxError ? "InvalidJsonSyntax" : (err as Error)?.name || "ReadError";
      throw new Error(`Failed to load gateway state at ${this.statePath}: ${errType}`);
    }
  }

  public saveState(): void {
    const state: GatewaySyncState = {
      login_fingerprint: this.getLoginFingerprint(),
      sync_buf: this.syncBuf,
      context_tokens: this.contextTokens,
      processed_message_keys: this.processedMessageKeys.slice(-MAX_PROCESSED_MESSAGE_KEYS),
      sent_reply_progress: this.sentReplyProgress,
      reply_deliveries: this.replyDeliveries,
      baseline_established: this.baselineEstablished,
      context_budgets: this.contextBudgets,
      inbound_watermarks: this.inboundWatermarks,
      delivery_outbox: this.outbox,
    };
    if (this.baselineInProgress) {
      state.baseline_in_progress = true;
    }
    if (this.baselineEstablishedAt) {
      state.baseline_established_at = this.baselineEstablishedAt;
    }
    writePrivateJsonSync(this.statePath, state);
  }

  public isReadyForActivePolling(): boolean {
    return this.baselineEstablished === true && !this.baselineInProgress;
  }

  public assertCanEstablishBaseline(): void {
    if (!this.account || !this.account.token) {
      throw new Error("Cannot establish baseline: WeChat credentials missing or invalid");
    }
    if (this.baselineEstablished) {
      throw new Error("Baseline is already established; refusing duplicate baseline initialization");
    }
    if (Object.keys(this.sentReplyProgress).length > 0 || Object.keys(this.replyDeliveries).length > 0) {
      throw new Error("Cannot establish baseline: active in-progress reply chunks exist in state");
    }
    if (!this.baselineInProgress && (this.syncBuf !== "" || this.processedMessageKeys.length > 0)) {
      throw new Error(
        "Cannot establish baseline: state already contains active sync cursor or processed message records without baseline_in_progress"
      );
    }
  }

  public beginBaseline(): void {
    this.assertCanEstablishBaseline();
    const prev = this.baselineInProgress;
    this.baselineInProgress = true;
    try {
      this.saveState();
    } catch (err) {
      this.baselineInProgress = prev;
      throw err;
    }
  }

  public markBaselineEstablished(): void {
    const prevEst = this.baselineEstablished;
    const prevInProg = this.baselineInProgress;
    const prevAt = this.baselineEstablishedAt;
    this.baselineEstablished = true;
    this.baselineInProgress = false;
    this.baselineEstablishedAt = new Date().toISOString();
    try {
      this.saveState();
    } catch (err) {
      this.baselineEstablished = prevEst;
      this.baselineInProgress = prevInProg;
      this.baselineEstablishedAt = prevAt;
      throw err;
    }
  }

  public computeDeliveryKey(chatId: string, clientId: string): string {
    if (!clientId) return "";
    const accountId = this.account?.accountId || "";
    return JSON.stringify([accountId, chatId, clientId]);
  }

  public isMessageProcessed(deliveryKey: string): boolean {
    if (!deliveryKey) return false;
    return this.processedMessageKeySet.has(deliveryKey);
  }

  public recordProcessedMessageKey(deliveryKey: string, options?: { preserveReplyEvidence?: boolean }): void {
    if (!deliveryKey) return;
    const previous = [...this.processedMessageKeys];
    const previousReplyProgress = this.sentReplyProgress[deliveryKey];
    const previousDelivery = this.replyDeliveries[deliveryKey];
    if (!this.processedMessageKeySet.has(deliveryKey)) {
      this.processedMessageKeys.push(deliveryKey);
      if (this.processedMessageKeys.length > MAX_PROCESSED_MESSAGE_KEYS) {
        this.processedMessageKeys = this.processedMessageKeys.slice(-MAX_PROCESSED_MESSAGE_KEYS);
      }
      this.processedMessageKeySet = new Set(this.processedMessageKeys);
    }
    if (!options?.preserveReplyEvidence) {
      delete this.sentReplyProgress[deliveryKey];
      delete this.replyDeliveries[deliveryKey];
    }
    try {
      this.saveState();
    } catch (err) {
      this.processedMessageKeys = previous;
      this.processedMessageKeySet = new Set(this.processedMessageKeys);
      if (previousReplyProgress !== undefined) {
        this.sentReplyProgress[deliveryKey] = previousReplyProgress;
      }
      if (previousDelivery) this.replyDeliveries[deliveryKey] = previousDelivery;
      throw err;
    }
  }

  public getReplySentChunks(deliveryKey: string): number {
    if (!deliveryKey) return 0;
    return this.sentReplyProgress[deliveryKey] || 0;
  }

  public hasUncertainReply(deliveryKey: string): boolean {
    return this.replyDeliveries[deliveryKey]?.inFlight === true;
  }

  public hasPermanentReplyFailure(deliveryKey: string): boolean {
    return this.replyDeliveries[deliveryKey]?.failureReason !== undefined;
  }

  public recordReplyFailure(deliveryKey: string, reason: NonNullable<ReplyDeliveryState["failureReason"]>): void {
    const previous = this.replyDeliveries[deliveryKey];
    if (!previous || previous.inFlight || previous.acknowledgedChunks === previous.totalChunks ||
        previous.failureReason !== undefined && previous.failureReason !== reason) {
      throw new Error("Invalid WeChat permanent reply failure transition");
    }
    if (previous.failureReason === reason) return;
    this.replyDeliveries[deliveryKey] = { ...previous, failureReason: reason };
    try { this.saveState(); }
    catch (error) { this.replyDeliveries[deliveryKey] = previous; throw error; }
  }

  public prepareReplyDelivery(deliveryKey: string, digest: string, totalChunks: number): ReplyDeliveryState {
    const previous = this.replyDeliveries[deliveryKey];
    if (previous) {
      if (previous.digest !== digest || previous.totalChunks !== totalChunks) {
        throw new Error("WeChat reply content or chunk plan changed; refusing replay");
      }
      if (previous.inFlight) throw new Error("WeChat reply delivery uncertain; refusing replay");
      if (previous.failureReason) throw new Error("WeChat reply permanently failed; refusing replay");
      return { ...previous };
    }
    if (this.getReplySentChunks(deliveryKey) > 0) {
      throw new Error("WeChat legacy reply progress requires review before replay");
    }
    const next = { ...this.replyDeliveries };
    let removedKey: string | undefined;
    if (Object.keys(next).length >= MAX_REPLY_DELIVERIES) {
      const completed = Object.keys(next).find(key => next[key].acknowledgedChunks === next[key].totalChunks && !next[key].inFlight &&
        !this.replyEvidenceProtection(key) && !this.outbox[key] && !(key.startsWith("image-reply:") && this.outbox[key.slice("image-reply:".length)]));
      if (!completed) throw new Error("WeChat reply delivery state capacity exhausted");
      delete next[completed];
      removedKey = completed;
    }
    const item = { digest, totalChunks, acknowledgedChunks: 0, inFlight: false };
    next[deliveryKey] = item;
    const before = this.replyDeliveries;
    const removedProgress = removedKey === undefined ? undefined : this.sentReplyProgress[removedKey];
    if (removedKey !== undefined) delete this.sentReplyProgress[removedKey];
    this.replyDeliveries = next;
    try { this.saveState(); }
    catch (error) {
      this.replyDeliveries = before;
      if (removedKey !== undefined && removedProgress !== undefined) this.sentReplyProgress[removedKey] = removedProgress;
      throw error;
    }
    return { ...item };
  }

  /**
   * Renewal reminders may change wording between releases. Only an unsent reminder
   * can be replaced; acknowledged or uncertain evidence remains immutable.
   */
  public prepareRenewalReplyDelivery(deliveryKey: string, digest: string, totalChunks: number): ReplyDeliveryState {
    if (!deliveryKey.startsWith("renewal:")) throw new Error("Invalid renewal delivery key");
    const previous = this.replyDeliveries[deliveryKey];
    if (!previous || (previous.digest === digest && previous.totalChunks === totalChunks) ||
        previous.acknowledgedChunks > 0 || previous.inFlight || previous.failureReason !== undefined) {
      return this.prepareReplyDelivery(deliveryKey, digest, totalChunks);
    }
    const next = { ...this.replyDeliveries, [deliveryKey]: { digest, totalChunks, acknowledgedChunks: 0, inFlight: false } };
    const before = this.replyDeliveries;
    this.replyDeliveries = next;
    try { this.saveState(); }
    catch (error) { this.replyDeliveries = before; throw error; }
    return { ...next[deliveryKey] };
  }

  public beginReplyChunk(deliveryKey: string, chunkIndex: number): void {
    this.updateReplyDelivery(deliveryKey, chunkIndex, true, false);
  }

  public confirmReplyChunk(deliveryKey: string, chunkIndex: number): void {
    this.updateReplyDelivery(deliveryKey, chunkIndex, false, true);
  }

  public rejectReplyChunk(deliveryKey: string, chunkIndex: number): void {
    this.updateReplyDelivery(deliveryKey, chunkIndex, false, false);
  }

  private updateReplyDelivery(deliveryKey: string, chunkIndex: number, inFlight: boolean, acknowledged: boolean): void {
    const previous = this.replyDeliveries[deliveryKey];
    if (!previous || previous.failureReason || previous.acknowledgedChunks !== chunkIndex || chunkIndex >= previous.totalChunks ||
        previous.inFlight === inFlight) {
      throw new Error("Invalid WeChat reply chunk transition");
    }
    const previousProgress = this.sentReplyProgress[deliveryKey];
    const count = chunkIndex + (acknowledged ? 1 : 0);
    this.replyDeliveries[deliveryKey] = { ...previous, acknowledgedChunks: count, inFlight };
    if (count > 0) this.sentReplyProgress[deliveryKey] = count;
    try { this.saveState(); }
    catch (error) {
      this.replyDeliveries[deliveryKey] = previous;
      if (previousProgress === undefined) delete this.sentReplyProgress[deliveryKey];
      else this.sentReplyProgress[deliveryKey] = previousProgress;
      throw error;
    }
  }

  public recordReplyChunkProgress(deliveryKey: string, chunksSent: number): void {
    if (!deliveryKey) return;
    const prev = this.sentReplyProgress[deliveryKey];
    this.sentReplyProgress[deliveryKey] = chunksSent;
    try {
      this.saveState();
    } catch (err) {
      if (prev !== undefined) {
        this.sentReplyProgress[deliveryKey] = prev;
      } else {
        delete this.sentReplyProgress[deliveryKey];
      }
      throw err;
    }
  }

  public setContextToken(chatId: string, token: string): void {
    if (!chatId || !token) return;
    this.contextTokens[chatId] = token;
  }

  public commitCursor(cursor: string): void {
    const previous = this.syncBuf;
    this.syncBuf = cursor;
    try {
      this.saveState();
    } catch (err) {
      this.syncBuf = previous;
      throw err;
    }
  }
}
