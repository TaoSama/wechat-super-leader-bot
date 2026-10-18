import { CHANNEL_VERSION } from "./protocol.js";
const MAX_TIMEOUT_MS = 1_000;
const TICKET_TTL_MS = 24 * 60 * 60 * 1_000;
const FAILURE_BACKOFF_MS = 2_000;
const MAX_CACHE_ENTRIES = 1_000;

type Account = { token: string; fingerprint: string };
type Entry = { ticket?: string; expiresAt: number; retryAt: number };
type TypingOptions = {
  request: (endpoint: string, payload: Record<string, unknown>, token: string,
    timeoutMs: number, parentSignal?: AbortSignal) => Promise<Record<string, unknown>>;
  getAccount: () => Account | null;
  getContextToken: (chatId: string) => string | undefined;
  timeoutMs?: number;
  now?: () => number;
};

function accepted(response: Record<string, unknown>): boolean {
  return typeof response === "object" && response !== null && !Array.isArray(response) &&
    ["ret", "errcode"].every(field => !Object.hasOwn(response, field) || response[field] === 0);
}

/** Best-effort typing signals: failures are handled as false and never expose credentials. */
export class TypingIndicator {
  private readonly entries = new Map<string, Entry>();
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private account: Account | null = null;
  private generation = 0;

  constructor(private readonly options: TypingOptions) {
    const timeout = options.timeoutMs ?? MAX_TIMEOUT_MS;
    if (!Number.isFinite(timeout) || timeout <= 0) throw new RangeError("Invalid typing timeout budget");
    this.timeoutMs = Math.min(timeout, MAX_TIMEOUT_MS);
    this.now = options.now ?? Date.now;
  }

  public async send(chatId: string, status: 1 | 2 = 1): Promise<boolean> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let generation = this.generation;
    try {
      const account = this.refreshAccount();
      generation = this.generation;
      if (!account?.token || !chatId || (status !== 1 && status !== 2)) return false;
      const cached = this.entries.get(chatId);
      if (cached && cached.retryAt > this.now()) return false;
      const deadline = Date.now() + this.timeoutMs;
      const timeout = new Promise<boolean>(resolve => {
        timer = setTimeout(() => {
          controller.abort();
          this.fail(chatId, generation);
          resolve(false);
        }, this.timeoutMs);
      });
      const work = this.perform(chatId, status, account, generation, deadline, controller.signal)
        .catch(() => {
          // Provider exceptions can contain tokens or response bodies; false handles the error.
          if (!controller.signal.aborted) this.fail(chatId, generation);
          return false;
        });
      return await Promise.race([work, timeout]);
    } catch {
      // Account/context access failures have the same best-effort contract as transport failures.
      this.fail(chatId, generation);
      return false;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
    }
  }

  private async perform(chatId: string, status: 1 | 2, account: Account, generation: number,
    deadline: number, signal: AbortSignal): Promise<boolean> {
    let entry = this.entries.get(chatId);
    if (!entry?.ticket || entry.expiresAt <= this.now()) {
      this.entries.delete(chatId);
      if (status === 2) return false;
      const contextToken = this.options.getContextToken(chatId);
      if (!contextToken) return false;
      const config = await this.options.request("ilink/bot/getconfig", {
        ilink_user_id: chatId,
        context_token: contextToken,
        base_info: { channel_version: CHANNEL_VERSION },
      }, account.token, this.remaining(deadline), signal);
      if (!this.current(generation, signal)) return false;
      if (!accepted(config) || config.ret !== 0 || typeof config.typing_ticket !== "string" ||
          !config.typing_ticket.trim()) {
        this.fail(chatId, generation);
        return false;
      }
      entry = { ticket: config.typing_ticket, expiresAt: this.now() + TICKET_TTL_MS, retryAt: 0 };
      this.put(chatId, entry);
    }
    if (!this.current(generation, signal)) return false;
    this.put(chatId, entry);
    const receipt = await this.options.request("ilink/bot/sendtyping", {
      ilink_user_id: chatId,
      typing_ticket: entry.ticket,
      status,
      base_info: { channel_version: CHANNEL_VERSION },
    }, account.token, this.remaining(deadline), signal);
    if (!this.current(generation, signal)) return false;
    if (!accepted(receipt)) {
      this.fail(chatId, generation);
      return false;
    }
    return true;
  }

  private remaining(deadline: number): number {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Typing budget expired");
    return remaining;
  }

  private refreshAccount(): Account | null {
    const account = this.options.getAccount();
    if (account?.token !== this.account?.token || account?.fingerprint !== this.account?.fingerprint) {
      this.entries.clear();
      this.generation++;
      this.account = account ? { ...account } : null;
    }
    return account;
  }

  private current(generation: number, signal: AbortSignal): boolean {
    this.refreshAccount();
    return !signal.aborted && generation === this.generation;
  }

  private fail(chatId: string, generation: number): void {
    if (generation !== this.generation) return;
    this.put(chatId, { expiresAt: 0, retryAt: this.now() + FAILURE_BACKOFF_MS });
  }

  private put(chatId: string, entry: Entry): void {
    this.entries.delete(chatId);
    this.entries.set(chatId, entry);
    if (this.entries.size > MAX_CACHE_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }
}
