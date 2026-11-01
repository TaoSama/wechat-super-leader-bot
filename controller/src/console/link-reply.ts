import { createHash } from "node:crypto";
import type { ConsoleLinkIssued } from "./auth.js";
import { ConsoleAuthError } from "./types.js";

const REDACTED_LOGIN = "#login=[REDACTED]";
export type ConsoleLinkResolver = (requestId: string) => Promise<ConsoleLinkIssued | null>;
export type ConsoleLinkRedactor = (requestId: string, text: string) => Promise<string>;

export function consoleLinkRequestId(chatId: string, messageId: string): string {
  return `console_link_${createHash("sha256").update(JSON.stringify([chatId, messageId])).digest("hex")}`;
}

export function redactConsoleLinkSecrets(text: string): string {
  return text.replace(/#login=[A-Za-z0-9_.~%-]+/g, REDACTED_LOGIN);
}

function storedLinkUrl(url: string, requestId: string): string {
  return url.replace(/#login=[A-Za-z0-9_.~%-]+$/, `#login=[CONSOLE_LINK:${requestId}]`);
}

export function redactIssuedConsoleLink(text: string, requestId: string, issuedUrl?: string): string {
  return issuedUrl ? text.replaceAll(issuedUrl, storedLinkUrl(issuedUrl, requestId)) : text;
}

/** Recover the generated final URL from an existing issuance, without issuing or extending it. */
export async function restoreConsoleLinkReply(
  text: string, chatId: string, messageId: string, resolve?: ConsoleLinkResolver,
): Promise<string> {
  const requestId = consoleLinkRequestId(chatId, messageId);
  const marker = `#login=[CONSOLE_LINK:${requestId}]`;
  if (!text.includes(marker)) return text;
  const finalLine = text.slice(text.lastIndexOf("\n") + 1);
  if (!/^https?:\/\/\S+$/.test(finalLine) || !finalLine.endsWith(marker)) return text;
  const link = await resolve?.(requestId);
  if (!link || finalLine !== storedLinkUrl(link.url, requestId)) {
    throw new ConsoleAuthError("Console link is unavailable or expired", 410);
  }
  return text.slice(0, text.length - finalLine.length) + link.url;
}
