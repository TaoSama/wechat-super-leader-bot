export const NOTIFICATION_TEXT_LIMIT = 8 * 1024 * 1024;
export const NOTIFICATION_TEXT_BYTES = 8 * 1024 * 1024;
export const NOTIFICATION_PART_LIMIT = 128;
export const NOTIFICATION_PART_TARGET_BYTES = 1024 * 1024;
const INVALID_UNICODE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const HIGH_SURROGATE = /[\uD800-\uDBFF]$/u;

/** Byte-bounded parts concatenate to the exact original Markdown. */
export function splitNotificationText(text: string): string[] {
  return splitNotificationTextChunks([text]);
}

/** Isolate large immutable results so a short Unicode header cannot widen an entire ASCII result. */
export function splitNotificationTextChunks(chunks: Iterable<string>): string[] {
  const parts: string[] = [];
  let pending: string[] = [], pendingBytes = 0, surrogate = "";
  const publish = (text: string) => {
    if (parts.length >= NOTIFICATION_PART_LIMIT) throw new Error("Notification exceeds multipart result budget");
    parts.push(text);
  };
  const flush = () => {
    if (!pendingBytes) return;
    publish(pending.length === 1 ? pending[0] : pending.join("")); pending = []; pendingBytes = 0;
  };
  for (const chunk of chunks) {
    let text = surrogate ? surrogate + chunk : chunk;
    surrogate = "";
    if (HIGH_SURROGATE.test(text)) { surrogate = text.slice(-1); text = text.slice(0, -1); }
    if (INVALID_UNICODE.test(text)) throw new Error("Notification Markdown contains invalid Unicode");
    if (!text) continue;
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes < NOTIFICATION_PART_TARGET_BYTES) {
      if (pendingBytes + bytes > NOTIFICATION_PART_TARGET_BYTES) flush();
      pending.push(text); pendingBytes += bytes;
      continue;
    }
    flush();
    // Slices share the source string; no aggregate buffer or per-character array is allocated.
    for (let start = 0; start < text.length;) {
      const end = boundedPrefixEnd(text, start);
      publish(start === 0 && end === text.length ? text : text.slice(start, end));
      start = end;
    }
  }
  if (surrogate) throw new Error("Notification Markdown contains invalid Unicode");
  flush();
  if (!parts.length) return [""];
  return parts;
}

function boundedPrefixEnd(text: string, start: number): number {
  const maximum = Math.min(text.length, start + NOTIFICATION_PART_TARGET_BYTES);
  if (Buffer.byteLength(text.slice(start, maximum), "utf8") <= NOTIFICATION_PART_TARGET_BYTES) {
    return HIGH_SURROGATE.test(text.slice(start, maximum)) ? maximum - 1 : maximum;
  }
  let low = start, high = maximum;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(start, middle), "utf8") <= NOTIFICATION_PART_TARGET_BYTES) low = middle;
    else high = middle - 1;
  }
  return HIGH_SURROGATE.test(text.slice(start, low)) ? low - 1 : low;
}
