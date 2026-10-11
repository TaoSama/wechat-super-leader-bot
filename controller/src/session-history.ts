import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  ControllerReadHistoryMessageSchema, DaemonHistoryMessageSchema,
  HistoryReadOptions, SessionHistory,
} from "./types.js";

const HISTORY_TIMEOUT_MS = 15000;
const HISTORY_MAX_PENDING = 32;
const HISTORY_MAX_PENDING_PER_NODE = 8;

export class HistoryError extends Error {
  constructor(public readonly httpStatus: number, public readonly code: string, message: string) {
    super(message);
    this.name = "HistoryError";
  }
}

const invalidResponse = () => new HistoryError(502, "history_invalid_response", "Invalid history response");
const disconnected = () => new HistoryError(503, "history_disconnected", "History node disconnected");
const aborted = () => new HistoryError(499, "history_aborted", "History request cancelled");
const timeout = () => new HistoryError(504, "history_timeout", "History request timed out");

function remoteError(message: string): HistoryError {
  switch (message) {
    case "Invalid history request": return new HistoryError(400, "history_invalid_request", message);
    case "History API unavailable": return new HistoryError(502, "history_unavailable", message);
    case "History request timed out": return timeout();
    case "Too many history requests": return new HistoryError(429, "history_busy", message);
    case "History response too large": return new HistoryError(413, "history_too_large", message);
    case "History context expired": return new HistoryError(409, "history_context_expired", message);
    case "History incomplete": return new HistoryError(502, "history_incomplete", message);
    default: return new HistoryError(502, "history_failed", "History request failed");
  }
}

interface PendingHistory {
  nodeId: string;
  sessionId: string;
  ws: WebSocket;
  limit: number;
  historyContext?: string;
  settle: (history?: SessionHistory, error?: HistoryError) => void;
}

/** Ephemeral history queries are isolated from the durable command lifecycle. */
export class SessionHistoryRequests {
  private pending = new Map<string, PendingHistory>();
  private pendingByNode = new Map<string, number>();

  async read(nodeId: string, sessionId: string, ws: WebSocket,
    options: HistoryReadOptions, signal?: AbortSignal): Promise<SessionHistory> {
    const parsed = ControllerReadHistoryMessageSchema.safeParse({
      ...options, type: "read_history", requestId: randomUUID(), nodeId, sessionId,
    });
    if (!parsed.success) throw new HistoryError(400, "history_invalid_request", "Invalid history request");
    if (signal?.aborted) throw aborted();
    const nodePending = this.pendingByNode.get(nodeId) ?? 0;
    if (this.pending.size >= HISTORY_MAX_PENDING || nodePending >= HISTORY_MAX_PENDING_PER_NODE) {
      throw new HistoryError(429, "history_busy", "Too many history requests");
    }
    const request = parsed.data;
    return new Promise<SessionHistory>((resolve, reject) => {
      let settled = false;
      const cancelPending = (error: HistoryError) => {
        if (settled) return;
        // Remove the request before sending: even a synchronous late reply is ignored.
        pending.settle(undefined, error);
        if (ws.readyState !== WebSocket.OPEN) return;
        const cancellation = { type: "cancel_history", requestId: request.requestId, nodeId, sessionId };
        const failed = () => console.warn("[history] cancellation transport failed");
        try {
          ws.send(JSON.stringify(cancellation), sendError => { if (sendError) failed(); });
        } catch {
          failed();
        }
      };
      const onAbort = () => cancelPending(aborted());
      const timer = setTimeout(() => cancelPending(timeout()), HISTORY_TIMEOUT_MS);
      const pending: PendingHistory = {
        nodeId, sessionId, ws, limit: request.limit, historyContext: request.historyContext,
        settle: (history, error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          this.pending.delete(request.requestId);
          const remaining = (this.pendingByNode.get(nodeId) ?? 1) - 1;
          if (remaining) this.pendingByNode.set(nodeId, remaining);
          else this.pendingByNode.delete(nodeId);
          if (error) reject(error);
          else if (history) resolve(history);
          else reject(invalidResponse());
        },
      };
      this.pending.set(request.requestId, pending);
      this.pendingByNode.set(nodeId, nodePending + 1);
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        ws.send(JSON.stringify(request), error => {
          if (error) pending.settle(undefined, disconnected());
        });
      } catch {
        pending.settle(undefined, disconnected());
      }
    });
  }

  receive(nodeId: string, ws: WebSocket, raw: unknown): boolean {
    if (!raw || typeof raw !== "object") return false;
    const envelope = raw as Record<string, unknown>;
    if (typeof envelope.requestId !== "string") return false;
    const pending = this.pending.get(envelope.requestId);
    if (!pending || pending.ws !== ws || pending.nodeId !== nodeId || pending.sessionId !== envelope.sessionId) return false;
    const parsed = DaemonHistoryMessageSchema.safeParse(raw);
    if (!parsed.success) {
      pending.settle(undefined, invalidResponse());
      return false;
    }
    const response = parsed.data;
    if (response.error !== undefined) pending.settle(undefined, remoteError(response.error));
    else if (response.history?.session.id !== pending.sessionId || response.history.items.length > pending.limit ||
        pending.historyContext !== undefined && response.history.historyContext !== pending.historyContext) {
      pending.settle(undefined, invalidResponse());
    } else pending.settle(response.history);
    return true;
  }

  disconnect(ws: WebSocket): void {
    for (const pending of this.pending.values()) {
      if (pending.ws === ws) pending.settle(undefined, disconnected());
    }
  }

  closeAll(): void {
    for (const pending of this.pending.values()) pending.settle(undefined, disconnected());
  }
}
