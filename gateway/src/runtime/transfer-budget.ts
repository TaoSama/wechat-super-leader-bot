// Local transfer policy, independent of any WeChat file-size or protocol limit.
export const MAX_TRANSFER_TIMEOUT_MS = 10 * 60_000;
const TRANSFER_BYTES_PER_SECOND = 1024 * 1024;

/** One MiB/s plus setup allowance; all retries share this single bounded deadline. */
export function transferTimeoutMs(byteLength: number, setupMs: number): number {
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0 ||
      !Number.isSafeInteger(setupMs) || setupMs <= 0 || setupMs > MAX_TRANSFER_TIMEOUT_MS) {
    throw new Error("Invalid transfer budget");
  }
  return Math.min(MAX_TRANSFER_TIMEOUT_MS, setupMs + Math.ceil(byteLength / TRANSFER_BYTES_PER_SECOND * 1000));
}
