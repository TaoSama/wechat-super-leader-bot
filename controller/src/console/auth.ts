import { createHmac, randomBytes } from "node:crypto";
import {
  ConsoleSessionRecord,
  ConsoleAuthError,
  IConsoleAuthStore,
  hashConsoleToken,
} from "./types.js";
import { validateConsolePublicUrl } from "../runtime/config.js";
import { redactIssuedConsoleLink } from "./link-reply.js";
export { ConsoleAuthError } from "./types.js";

export const CONSOLE_LINK_TTL_MS = 3600 * 1000; // 1 hour
export const CONSOLE_SESSION_TTL_MS = 3600 * 1000; // 1 hour

export interface ConsoleLinkIssued {
  url: string;
  expiresAt: string;
}

export interface ConsoleSessionIssued {
  sessionToken: string;
  expiresAt: string;
}

export class ConsoleAuthService {
  private publicUrlOrigin?: string;

  constructor(
    private readonly store: IConsoleAuthStore,
    publicUrl: string | undefined,
    private readonly controllerToken: string,
    private readonly now: () => number = Date.now,
    private readonly onSessionRevoked?: (sessionToken: string) => void
  ) {
    this.publicUrlOrigin = validateConsolePublicUrl(publicUrl);
  }

  getPublicUrl(): string | undefined {
    return this.publicUrlOrigin;
  }

  /** A chat-bound link lets its sessions manage that chat's plans and goals; unbound links stay limited to session writes. */
  async issueLink(requestId: string, chatId?: string): Promise<ConsoleLinkIssued> {
    if (!this.publicUrlOrigin) {
      throw new ConsoleAuthError("Console public URL is not configured", 503);
    }
    const rawToken = this.linkToken(requestId);
    const tokenHash = hashConsoleToken(rawToken);
    const nowMs = this.now();
    const createdAt = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + CONSOLE_LINK_TTL_MS).toISOString();

    const record = await this.store.createConsoleLinkIfAbsent({
      tokenHash,
      createdAt,
      expiresAt,
      ...(chatId === undefined ? {} : { chatId }),
    });

    if (Date.parse(record.expiresAt) <= nowMs) {
      throw new ConsoleAuthError("Console link has expired", 410);
    }

    return {
      url: `${this.publicUrlOrigin}/#login=${rawToken}`,
      expiresAt: record.expiresAt,
    };
  }

  async recoverLink(requestId: string): Promise<ConsoleLinkIssued | null> {
    const link = await this.existingLink(requestId);
    return link && Date.parse(link.expiresAt) > this.now() ? link : null;
  }

  async redactReply(requestId: string, text: string): Promise<string> {
    if (!text.includes("#login=")) return text;
    const link = await this.existingLink(requestId);
    return redactIssuedConsoleLink(text, requestId, link?.url);
  }

  private async existingLink(requestId: string): Promise<ConsoleLinkIssued | null> {
    if (!this.publicUrlOrigin) return null;
    const rawToken = this.linkToken(requestId);
    const record = await this.store.getConsoleLink(hashConsoleToken(rawToken));
    if (!record) return null;
    return { url: `${this.publicUrlOrigin}/#login=${rawToken}`, expiresAt: record.expiresAt };
  }

  private linkToken(requestId: string): string {
    if (typeof requestId !== "string" || requestId.trim().length === 0 || requestId.length > 256) {
      throw new ConsoleAuthError("Invalid requestId: must be a non-empty string", 400);
    }
    return createHmac("sha256", this.controllerToken)
      .update("super-leader:console-link:" + requestId.trim())
      .digest("base64url");
  }

  async exchangeToken(rawToken: string): Promise<ConsoleSessionIssued | null> {
    if (typeof rawToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(rawToken)) {
      return null;
    }

    const tokenHash = hashConsoleToken(rawToken);
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    const sessionExpiresAt = new Date(nowMs + CONSOLE_SESSION_TTL_MS).toISOString();

    const sessionToken = randomBytes(32).toString("base64url");
    const sessionTokenHash = hashConsoleToken(sessionToken);

    const sessionRecord: ConsoleSessionRecord = {
      tokenHash: sessionTokenHash,
      createdAt: nowIso,
      expiresAt: sessionExpiresAt,
    };

    const success = await this.store.consumeConsoleLink(tokenHash, sessionRecord, nowIso);
    if (!success) {
      return null;
    }

    return {
      sessionToken,
      expiresAt: sessionExpiresAt,
    };
  }

  async verifySession(sessionToken: string): Promise<ConsoleSessionRecord | null> {
    if (typeof sessionToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(sessionToken.trim())) {
      return null;
    }

    const sessionTokenHash = hashConsoleToken(sessionToken.trim());
    const nowIso = new Date(this.now()).toISOString();
    return this.store.getConsoleSession(sessionTokenHash, nowIso);
  }

  async deleteSession(sessionToken: string): Promise<void> {
    if (typeof sessionToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(sessionToken.trim())) {
      return;
    }

    const sessionTokenHash = hashConsoleToken(sessionToken.trim());
    await this.store.deleteConsoleSession(sessionTokenHash);
    this.onSessionRevoked?.(sessionToken.trim());
  }
}
