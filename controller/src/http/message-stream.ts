import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import type { QueryProgressReporter } from "../notifications/model-progress.js";
import { PROGRESS_TEXT_LIMIT } from "../notifications/progress.js";
import { traceEvent } from "../runtime/telemetry.js";

const PROGRESS_LIMIT = 3;
const DRAIN_TIMEOUT_MS = 10_000;

/** Negotiate progress frames while preserving the existing JSON response contract. */
export function createMessageStream(req: Request, res: Response): {
  report: QueryProgressReporter;
  reply: (reply: unknown) => Promise<void>;
} | undefined {
  if (!req.accepts("application/x-ndjson") || !req.headers.accept?.includes("application/x-ndjson")) return;
  const raw = req.headers["x-progress-remaining"];
  if (typeof raw !== "string" || !/^[0-3]$/.test(raw)) {
    res.status(400).json({ error: "Invalid progress budget" });
    return;
  }
  let remaining = Number(raw);
  const write = async (event: unknown): Promise<void> => {
    if (res.destroyed || res.writableEnded) throw new Error("Progress connection closed");
    if (!res.headersSent) {
      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      res.setHeader("X-Accel-Buffering", "no");
    }
    if (res.write(JSON.stringify(event) + "\n")) return;
    await new Promise<void>((resolve, reject) => {
      const clean = () => { clearTimeout(timer); res.off("drain", drained); res.off("close", closed); res.off("error", failed); };
      const drained = () => { clean(); resolve(); };
      const closed = () => { clean(); reject(new Error("Progress connection closed")); };
      const failed = () => { clean(); reject(new Error("Progress connection failed")); };
      const timer = setTimeout(() => { clean(); res.destroy(); reject(new Error("Progress connection stalled")); }, DRAIN_TIMEOUT_MS);
      res.once("drain", drained); res.once("close", closed); res.once("error", failed);
    });
  };
  return {
    report: async text => {
      if (!text.trim() || text.length > PROGRESS_TEXT_LIMIT) return { status: "invalid", remaining, limit: PROGRESS_LIMIT };
      if (remaining <= 0) return { status: "limit_reached", remaining, limit: PROGRESS_LIMIT };
      if (res.destroyed || res.writableEnded) return { status: "disconnected", remaining, limit: PROGRESS_LIMIT };
      // An attempted write can already be delivered when the connection fails; never reuse its slot.
      remaining--;
      try {
        await write({ type: "progress", id: randomUUID(), text, remaining });
        return { status: "queued", remaining, limit: PROGRESS_LIMIT };
      } catch {
        traceEvent("controller.progress.write", { outcome: "delivery_uncertain" });
        return { status: "delivery_uncertain", remaining, limit: PROGRESS_LIMIT };
      }
    },
    reply: async reply => { await write({ type: "reply", reply }); res.end(); },
  };
}
