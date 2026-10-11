import { createHash } from "node:crypto";

export const CONSOLE_TOKEN_HASH_HEX_LENGTH = 64;
const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/;

export interface ConsoleLinkRecord {
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
}

export interface ConsoleSessionRecord {
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
}

export interface IConsoleAuthStore {
  createConsoleLinkIfAbsent(record: ConsoleLinkRecord): Promise<ConsoleLinkRecord>;
  consumeConsoleLink(tokenHash: string, session: ConsoleSessionRecord, now: string): Promise<boolean>;
  getConsoleSession(tokenHash: string, now: string): Promise<ConsoleSessionRecord | null>;
  deleteConsoleSession(tokenHash: string): Promise<void>;
}

export function hashConsoleToken(rawToken: string): string {
  if (typeof rawToken !== "string" || rawToken.trim().length === 0) {
    throw new Error("Invalid console token: must be a non-empty string");
  }
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

export function validateConsoleTokenHash(tokenHash: string): string {
  if (typeof tokenHash !== "string" || !SHA256_HEX_REGEX.test(tokenHash)) {
    throw new Error(
      "Invalid tokenHash: must be a 64-character lowercase hexadecimal SHA-256 digest (raw tokens must not be stored)"
    );
  }
  return tokenHash;
}

export function validateIsoTimestamp(value: string, fieldName: string): { iso: string; ms: number } {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim() !== value) {
    throw new Error(`Invalid ${fieldName}: must be a non-empty ISO timestamp string`);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new Error(`Invalid ${fieldName}: failed to parse ISO timestamp`);
  }
  return { iso: new Date(ms).toISOString(), ms };
}

export function normalizeConsoleLinkRecord(record: ConsoleLinkRecord): ConsoleLinkRecord {
  if (!record || typeof record !== "object") {
    throw new Error("Invalid ConsoleLinkRecord: must be an object");
  }
  const tokenHash = validateConsoleTokenHash(record.tokenHash);
  const createdAt = validateIsoTimestamp(record.createdAt, "createdAt");
  const expiresAt = validateIsoTimestamp(record.expiresAt, "expiresAt");
  if (expiresAt.ms <= createdAt.ms) {
    throw new Error("Invalid ConsoleLinkRecord: expiresAt must be greater than createdAt");
  }
  const normalized: ConsoleLinkRecord = {
    tokenHash,
    createdAt: createdAt.iso,
    expiresAt: expiresAt.iso,
  };
  if (record.consumedAt !== undefined) {
    const consumedAt = validateIsoTimestamp(record.consumedAt, "consumedAt");
    normalized.consumedAt = consumedAt.iso;
  }
  return normalized;
}

export function normalizeConsoleSessionRecord(record: ConsoleSessionRecord): ConsoleSessionRecord {
  if (!record || typeof record !== "object") {
    throw new Error("Invalid ConsoleSessionRecord: must be an object");
  }
  const tokenHash = validateConsoleTokenHash(record.tokenHash);
  const createdAt = validateIsoTimestamp(record.createdAt, "createdAt");
  const expiresAt = validateIsoTimestamp(record.expiresAt, "expiresAt");
  if (expiresAt.ms <= createdAt.ms) {
    throw new Error("Invalid ConsoleSessionRecord: expiresAt must be greater than createdAt");
  }
  return {
    tokenHash,
    createdAt: createdAt.iso,
    expiresAt: expiresAt.iso,
  };
}

export function cloneConsoleLinkRecord(record: ConsoleLinkRecord): ConsoleLinkRecord {
  return record.consumedAt !== undefined
    ? {
        tokenHash: record.tokenHash,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
        consumedAt: record.consumedAt,
      }
    : {
        tokenHash: record.tokenHash,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
      };
}

export function cloneConsoleSessionRecord(record: ConsoleSessionRecord): ConsoleSessionRecord {
  return {
    tokenHash: record.tokenHash,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  };
}
