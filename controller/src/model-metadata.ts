export const MAX_MODEL_METADATA_BYTES = 256;

/** Reject malformed identifiers without trimming or truncating them into another value. */
export function sanitizeModelMetadata(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.trim() === value &&
    Buffer.byteLength(value, "utf8") <= MAX_MODEL_METADATA_BYTES &&
    !/[\p{Cc}\uD800-\uDFFF\uFFFD]/u.test(value) ? value : undefined;
}
