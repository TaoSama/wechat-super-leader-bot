import { ModelFailure, transportFailure } from "./errors.js";

export function cancelBodySafely(body: { cancel(): Promise<unknown> } | null | undefined): void {
  if (!body) return;
  try {
    // Do not let an uncooperative stream's cancellation block the request deadline.
    void body.cancel().catch(() => { console.warn("Model stream cancellation failed"); });
  } catch {
    console.warn("Model stream cancellation failed");
  }
}

export async function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Model request aborted");
  }
  if (ms <= 0) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error("Model request aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function readBoundedStream(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  signal: AbortSignal
): Promise<string> {
  if (signal.aborted) {
    cancelBodySafely(stream);
    throw signal.reason instanceof Error ? signal.reason : new Error("Model request aborted");
  }
  if (!stream) {
    return "";
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  let abortReject: ((err: Error) => void) | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    abortReject = reject;
  });

  const onAbort = () => {
    const reason =
      signal.reason instanceof Error ? signal.reason : new Error("Model request aborted");
    if (abortReject) {
      abortReject(reason);
    }
    cancelBodySafely(reader);
  };

  signal.addEventListener("abort", onAbort, { once: true });

  try {
    while (true) {
      if (signal.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error("Model request aborted");
      }

      let readResult: ReadableStreamReadResult<Uint8Array>;
      try {
        readResult = await Promise.race([reader.read(), abortPromise]);
      } catch (readErr: unknown) {
        if (signal.aborted) {
          throw signal.reason instanceof Error ? signal.reason : new Error("Model request aborted");
        }
        cancelBodySafely(reader);
        throw transportFailure(readErr, "response_body");
      }

      const { done, value } = readResult;
      if (done) {
        break;
      }
      if (value) {
        if (!(value instanceof Uint8Array)) {
          cancelBodySafely(reader);
          throw new ModelFailure("Invalid model response: stream chunk must be Uint8Array", { category: "invalid_response" });
        }
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          cancelBodySafely(reader);
          throw new ModelFailure(`Model response exceeded maximum allowed size of ${maxBytes} bytes`, { category: "invalid_response" });
        }
        chunks.push(value);
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch (releaseErr: unknown) {
      console.warn("Model stream lock release failed");
    }
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(combined);
}
