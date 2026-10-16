import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { WeChatAccount, GatewaySyncState } from "../types.js";

export const MAX_PROCESSED_MESSAGE_KEYS = 1000;

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

export class StateManager {
  public readonly credentialsPath: string;
  public readonly statePath: string;
  public account: WeChatAccount | null = null;
  public syncBuf: string = "";
  public contextTokens: Record<string, string> = {};
  public processedMessageKeys: string[] = [];
  public sentReplyProgress: Record<string, number> = {};
  public baselineEstablished: boolean = false;
  public baselineInProgress: boolean = false;
  public baselineEstablishedAt: string | undefined = undefined;
  private processedMessageKeySet: Set<string> = new Set();

  constructor(credentialsPath: string, statePath?: string) {
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
        accountId: String(parsed.accountId || ""),
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
      baseline_established: this.baselineEstablished,
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
    if (Object.keys(this.sentReplyProgress).length > 0) {
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

  public recordProcessedMessageKey(deliveryKey: string): void {
    if (!deliveryKey) return;
    const previous = [...this.processedMessageKeys];
    const previousReplyProgress = this.sentReplyProgress[deliveryKey];
    if (!this.processedMessageKeySet.has(deliveryKey)) {
      this.processedMessageKeys.push(deliveryKey);
      if (this.processedMessageKeys.length > MAX_PROCESSED_MESSAGE_KEYS) {
        this.processedMessageKeys = this.processedMessageKeys.slice(-MAX_PROCESSED_MESSAGE_KEYS);
      }
      this.processedMessageKeySet = new Set(this.processedMessageKeys);
    }
    delete this.sentReplyProgress[deliveryKey];
    try {
      this.saveState();
    } catch (err) {
      this.processedMessageKeys = previous;
      this.processedMessageKeySet = new Set(this.processedMessageKeys);
      if (previousReplyProgress !== undefined) {
        this.sentReplyProgress[deliveryKey] = previousReplyProgress;
      }
      throw err;
    }
  }

  public getReplySentChunks(deliveryKey: string): number {
    if (!deliveryKey) return 0;
    return this.sentReplyProgress[deliveryKey] || 0;
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
