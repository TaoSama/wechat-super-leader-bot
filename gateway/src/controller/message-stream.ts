import type { ControllerMessageResponse } from "../types.js";
import { beforeAbort } from "../runtime/abort.js";
import { parseControllerReply } from "./reply-client.js";
import { traceEvent } from "../runtime/telemetry.js";
import { MAX_PROGRESS_CHARS, QUERY_PROGRESS_LIMIT } from "../leader/progress.js";

export interface ForwardMessageProgress {
  onProgress: (text: string, id: string) => Promise<{ sent: boolean; reason?: string }>;
  progressRemaining: number;
}

const MAX_FRAME_BYTES = 256 * 1024;
const MAX_STREAM_BYTES = 1024 * 1024;

function invalid(): Error { return new Error("Controller /v1/messages returned invalid response schema (progress stream)"); }

/** Consume each report before reading more, so delivery provides bounded backpressure. */
export async function readMessageStream(response: Response, options: ForwardMessageProgress,
  signal: AbortSignal): Promise<ControllerMessageResponse> {
  if (!response.body) throw invalid();
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  let totalBytes = 0;
  let remaining = options.progressRemaining;
  let reply: ControllerMessageResponse | undefined;
  const seen = new Set<string>();
  const consume = async (line: string) => {
    if (!line || Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES || reply) throw invalid();
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw invalid(); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
    const event = value as Record<string, unknown>;
    if (event.type === "reply") {
      if (Object.keys(event).length !== 2) throw invalid();
      reply = parseControllerReply(event.reply, "/v1/messages");
      return;
    }
    if (event.type === "error") throw new Error("Controller progress stream ended before its final reply; outcome uncertain");
    if (event.type !== "progress" || Object.keys(event).length !== 4 ||
      typeof event.id !== "string" || !event.id || event.id.length > 128 || seen.has(event.id) ||
      typeof event.text !== "string" || !event.text.trim() || event.text.length > MAX_PROGRESS_CHARS ||
      !Number.isInteger(event.remaining) || event.remaining !== remaining - 1 || remaining <= 0 ||
      seen.size >= QUERY_PROGRESS_LIMIT) throw invalid();
    seen.add(event.id);
    remaining--;
    await beforeAbort(options.onProgress(event.text, event.id), signal);
  };
  try {
    while (true) {
      const chunk = await beforeAbort(reader.read(), signal);
      signal.throwIfAborted();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > MAX_STREAM_BYTES) throw invalid();
      pending += decoder.decode(chunk.value, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        await consume(line);
      }
      if (Buffer.byteLength(pending, "utf8") > MAX_FRAME_BYTES) throw invalid();
    }
    pending += decoder.decode();
    if (pending || !reply) throw invalid();
    return reply;
  } finally {
    // Cancellation is best effort; awaiting a non-compliant reader could exceed the query deadline.
    void reader.cancel().catch(() => traceEvent("controller.stream.cancel", { outcome: "error" }));
    reader.releaseLock();
  }
}
