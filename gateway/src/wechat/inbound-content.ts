import type { InboundMediaRef, UnsupportedInboundKind } from "../types.js";
import { unicodeSafeBoundary } from "./markdown.js";

export const ITEM_TYPE_TEXT = 1;
export const ITEM_TYPE_IMAGE = 2;
export const ITEM_TYPE_VOICE = 3;
export const ITEM_TYPE_FILE = 4;
export const ITEM_TYPE_VIDEO = 5;
export const QUOTE_MAX_CHARS = 200;
/** Attachments beyond this count in one message are ignored. */
export const MAX_INBOUND_MEDIA = 3;
export const MAX_MEDIA_PARAM_CHARS = 8192;
export const MAX_MEDIA_FILE_NAME_CHARS = 255;
const AES_KEY_BYTES = 16;
const AES_KEY_HEX = /^[0-9a-fA-F]{32}$/u;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;
const QUOTE_ELLIPSIS = "…";

const MEDIA_KINDS = new Map<number, UnsupportedInboundKind>([
  [ITEM_TYPE_IMAGE, "image"], [ITEM_TYPE_VOICE, "voice"], [ITEM_TYPE_FILE, "file"], [ITEM_TYPE_VIDEO, "video"],
]);

export interface InboundContent {
  /** Text forwarded to the leader, including a delimited quote prefix when present. */
  text: string;
  /** The sender's own words without the quote; keeps legacy deterministic identities stable. */
  ownText: string;
  /** Present only when the message has neither usable text nor supported media. */
  unsupportedKinds?: UnsupportedInboundKind[];
  media?: InboundMediaRef[];
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

function boundedString(value: unknown, maxChars: number): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= maxChars && !CONTROL_CHARS.test(value) ? value : undefined;
}

/** image_item.aeskey is raw hex; CDNMedia.aes_key is base64 of either the raw key or its hex text. */
export function normalizeAesKey(hexKey: unknown, base64Key: unknown): string | undefined | null {
  if (typeof hexKey === "string" && hexKey) return AES_KEY_HEX.test(hexKey) ? hexKey.toLowerCase() : null;
  if (typeof base64Key !== "string" || !base64Key) return undefined;
  if (base64Key.length > 64 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(base64Key)) return null;
  const decoded = Buffer.from(base64Key, "base64");
  if (decoded.length === AES_KEY_BYTES) return decoded.toString("hex");
  const text = decoded.toString("ascii");
  return decoded.length === AES_KEY_BYTES * 2 && AES_KEY_HEX.test(text) ? text.toLowerCase() : null;
}

/** Returns a reference, or null when the item claims media but its reference is unusable. */
function mediaRef(item: Record<string, unknown>): InboundMediaRef | null | undefined {
  const kind = item.type === ITEM_TYPE_IMAGE ? "image" : item.type === ITEM_TYPE_FILE ? "file" : undefined;
  if (!kind) return undefined;
  const body = record(kind === "image" ? item.image_item : item.file_item);
  const media = record(body?.media);
  if (!body || !media) return null;
  const fullUrl = boundedString(media.full_url, MAX_MEDIA_PARAM_CHARS);
  const encryptQueryParam = boundedString(media.encrypt_query_param, MAX_MEDIA_PARAM_CHARS);
  if (!fullUrl && !encryptQueryParam) return null;
  const aesKeyHex = normalizeAesKey(kind === "image" ? body.aeskey : undefined, media.aes_key);
  // Only images are observed as plaintext CDN objects; files must be encrypted.
  if (aesKeyHex === null || (kind === "file" && !aesKeyHex)) return null;
  const fileName = kind === "file" ? boundedString(body.file_name, MAX_MEDIA_FILE_NAME_CHARS) : undefined;
  return { kind, ...(fullUrl ? { fullUrl } : {}), ...(encryptQueryParam ? { encryptQueryParam } : {}),
    ...(aesKeyHex ? { aesKeyHex } : {}), ...(fileName ? { fileName } : {}) };
}

/** Returns undefined when the item list carries neither text nor a recognizable attachment. */
export function parseInboundContent(itemList: unknown[]): InboundContent | undefined {
  const items = itemList.map(record).filter((item): item is Record<string, unknown> => item !== undefined);
  const ownText = items.map(itemText).join("");
  const media: InboundMediaRef[] = [];
  const kinds = new Set<UnsupportedInboundKind>();
  for (const item of items) {
    const ref = mediaRef(item);
    if (ref) { if (media.length < MAX_INBOUND_MEDIA) media.push(ref); continue; }
    if (item.type === ITEM_TYPE_TEXT || (item.type === ITEM_TYPE_VOICE && itemText(item))) continue;
    kinds.add(typeof item.type === "number" ? MEDIA_KINDS.get(item.type) ?? "unknown" : "unknown");
  }
  const withMedia = media.length ? { media } : {};
  if (ownText) return { text: quotePrefix(items) + ownText, ownText, ...withMedia };
  // Supported media alone becomes pending chat context; unsupported siblings are not announced.
  if (media.length) return { text: "", ownText, media };
  return kinds.size ? { text: "", ownText, unsupportedKinds: [...kinds] } : undefined;
}
