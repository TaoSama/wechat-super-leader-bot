import { WebSocket } from "ws";
import type { ControllerCommandMessage } from "../types.js";

export const COMMAND_WRITE_TIMEOUT_MS = 5000;
export const MAX_PENDING_COMMANDS_PER_SOCKET = 64;
export const MAX_COMMAND_BUFFERED_BYTES = 1024 * 1024;
const MAX_SERVER_FRAME_HEADER_BYTES = 10;

export interface CommandDelivery { delivered: boolean; error?: string; rejected?: boolean }
type Settle = (delivery: CommandDelivery) => void;

/** A write acknowledgement is transport evidence only; failed writes may have executed remotely. */
export class CommandTransport {
  private pending = new Map<WebSocket, Set<Settle>>();

  async send(ws: WebSocket, command: ControllerCommandMessage, signal?: AbortSignal): Promise<CommandDelivery> {
    if (signal?.aborted) return { delivered: false, error: "Command transport stopped" };
    if (ws.readyState !== WebSocket.OPEN) return { delivered: false, error: "Command node disconnected" };
    const remaining = Math.min(COMMAND_WRITE_TIMEOUT_MS, Date.parse(command.expiresAt) - Date.now());
    if (!Number.isFinite(remaining) || remaining <= 0) return { delivered: false, error: "Command expired before write" };
    let payload: string;
    try { payload = JSON.stringify(command); }
    catch (error) { return { delivered: false, error: error instanceof Error ? error.message : "Command serialization failed" }; }

    const pending = this.pending.get(ws) ?? new Set<Settle>();
    const wireBytes = Buffer.byteLength(payload, "utf8") + MAX_SERVER_FRAME_HEADER_BYTES;
    if (pending.size >= MAX_PENDING_COMMANDS_PER_SOCKET || ws.bufferedAmount + wireBytes > MAX_COMMAND_BUFFERED_BYTES) {
      const error = "Command transport backpressure limit exceeded";
      this.terminate(ws, error);
      return { delivered: false, error };
    }

    return new Promise(resolve => {
      let settled = false;
      const settle: Settle = delivery => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        pending.delete(settle);
        if (!pending.size && this.pending.get(ws) === pending) this.pending.delete(ws);
        resolve(delivery);
      };
      const onAbort = () => this.terminate(ws, "Command transport stopped");
      const timer = setTimeout(() => this.terminate(ws, "Command write deadline exceeded"), remaining);
      pending.add(settle);
      this.pending.set(ws, pending);
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        ws.send(payload, error => {
          if (error) this.terminate(ws, error.message);
          else settle({ delivered: true });
        });
      } catch (error) {
        this.terminate(ws, error instanceof Error ? error.message : "Command write failed");
      }
    });
  }

  disconnect(ws: WebSocket, error = "Command node disconnected"): void {
    const pending = this.pending.get(ws);
    this.pending.delete(ws);
    for (const settle of pending ?? []) settle({ delivered: false, error });
  }

  private terminate(ws: WebSocket, error: string): void {
    this.disconnect(ws, error);
    // A closing handshake can sit behind buffered commands; discard that connection immediately.
    try { ws.terminate(); }
    catch (cause) { console.error("Error terminating command transport:", cause); }
  }

  closeAll(): void {
    for (const ws of [...this.pending.keys()]) this.terminate(ws, "Command transport stopped");
  }
}
