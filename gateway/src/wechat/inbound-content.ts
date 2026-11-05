import type { UnsupportedInboundKind } from "../types.js";
import { unicodeSafeBoundary } from "./markdown.js";

export const ITEM_TYPE_TEXT = 1;
export const ITEM_TYPE_IMAGE = 2;
export const ITEM_TYPE_VOICE = 3;
export const ITEM_TYPE_FILE = 4;
export const ITEM_TYPE_VIDEO = 5;
export const QUOTE_MAX_CHARS = 200;
const QUOTE_ELLIPSIS = "…";

const MEDIA_KINDS = new Map<number, UnsupportedInboundKind>([
  [ITEM_TYPE_IMAGE, "image"], [ITEM_TYPE_VOICE, "voice"], [ITEM_TYPE_FILE, "file"], [ITEM_TYPE_VIDEO, "video"],
]);

export interface InboundContent {
  /** Text forwarded to the leader, including a delimited quote prefix when present. */
  text: string;
  /** The sender's own words without the quote; keeps legacy deterministic identities stable. */
  ownText: string;
  /** Present only when the message has no usable text. */
  unsupportedKinds?: UnsupportedInboundKind[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Text item content, or the platform speech-to-text of a voice item. */
function itemText(item: Record<string, unknown>): string {
  const field = item.type === ITEM_TYPE_TEXT ? record(item.text_item)?.text
    : item.type === ITEM_TYPE_VOICE ? record(item.voice_item)?.text : undefined;
  return typeof field === "string" ? field : "";
}

function quotePrefix(items: Record<string, unknown>[]): string {
  for (const item of items) {
    const ref = record(item.ref_msg);
    if (!ref) continue;
    const quotedItem = record(ref.message_item);
    const title = typeof ref.title === "string" ? ref.title : "";
    const quoted = ((quotedItem ? itemText(quotedItem) : "") || title).replace(/\s+/gu, " ").trim();
    if (!quoted) return "";
    const cut = quoted.length > QUOTE_MAX_CHARS ? unicodeSafeBoundary(quoted, QUOTE_MAX_CHARS) : quoted.length;
    return `引用：「${quoted.slice(0, cut)}${cut < quoted.length ? QUOTE_ELLIPSIS : ""}」\n`;
  }
  return "";
}

/** Returns undefined when the item list carries neither text nor a recognizable attachment. */
export function parseInboundContent(itemList: unknown[]): InboundContent | undefined {
  const items = itemList.map(record).filter((item): item is Record<string, unknown> => item !== undefined);
  const ownText = items.map(itemText).join("");
  if (ownText) return { text: quotePrefix(items) + ownText, ownText };
  const kinds = new Set<UnsupportedInboundKind>();
  for (const item of items) {
    if (item.type === ITEM_TYPE_TEXT) continue;
    kinds.add(typeof item.type === "number" ? MEDIA_KINDS.get(item.type) ?? "unknown" : "unknown");
  }
  return kinds.size ? { text: "", ownText, unsupportedKinds: [...kinds] } : undefined;
}
