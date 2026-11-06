import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

export type WatchdogResetKind = "initial" | "ping" | "schema_message" | "history_response" |
  "media_response" | "automation_response";
type CloseCause = "server_stopping" | "duplicate_identity" | "heartbeat_timeout" |
  "control_message_too_large" | "invalid_session_inventory" | "repeated_hello" |
  "node_identity_mismatch" | "message_before_hello" | "server_shutdown";
type ReleaseCause = "socket_close" | "replacement" | "shutdown";
type LifecycleEvent = "connection_accepted" | "connection_rejected" | "hello_accepted" |
  "close_requested" | "socket_closed" | "node_slot_released" | "socket_error";

interface Trace {
  ws: WebSocket;
  connectionId: string;
  nodeId: string;
  generation: number | null;
  connectedAt: number;
  watchdogResetAt: number;
  watchdogResetKind: WatchdogResetKind;
  helloAccepted: boolean;
  firstCloseAttempt?: { cause: CloseCause; atUTC: string };
  errorSeen: boolean;
}

interface EventFields {
  cause?: CloseCause | ReleaseCause;
  requestedCode?: number;
  timeoutMs?: number;
  closeCode?: number | null;
  isCurrentSlot?: boolean;
  hubStopping?: boolean;
  hubCloseAttemptSeen?: boolean;
  firstHubCloseCause?: CloseCause;
  firstHubCloseAtUTC?: string;
  occupyingConnectionId?: string;
  occupyingGeneration?: number | null;
  occupyingSocketState?: string;
  occupyingHelloAccepted?: boolean;
  occupyingWatchdogResetAgeMs?: number;
  replacementConnectionId?: string;
}

const SOCKET_STATES = ["connecting", "open", "closing", "closed"] as const;
const ageMs = (now: number, since: number): number => Math.max(0, Math.floor(now - since));

/** Observes Hub decisions without owning socket closure, node slots, or persistence. */
export class ConnectionLifecycle {
  private readonly hubId = randomUUID();
  private readonly traces = new WeakMap<WebSocket, Trace>();
  private readonly sourceRevision = /^[0-9a-f]{40}$/.test(process.env.SOURCE_REVISION ?? "")
    ? process.env.SOURCE_REVISION! : "unknown";
  private connectionSequence = 0;
  private eventSequence = 0;

  begin(ws: WebSocket, nodeId: string, slotState: () => { isCurrentSlot: boolean; hubStopping: boolean }): void {
    const now = performance.now();
    const trace: Trace = {
      ws, nodeId, connectionId: `${this.hubId}:${++this.connectionSequence}`, generation: null,
      connectedAt: now, watchdogResetAt: now, watchdogResetKind: "initial", helloAccepted: false, errorSeen: false,
    };
    this.traces.set(ws, trace);
    ws.once("close", (code: number) => {
      // A missing Hub close attempt says nothing about peer/network/transport initiation.
      this.write("socket_closed", trace, {
        closeCode: Number.isInteger(code) ? code : null,
        ...slotState(), hubCloseAttemptSeen: trace.firstCloseAttempt !== undefined,
        ...(trace.firstCloseAttempt ? {
          firstHubCloseCause: trace.firstCloseAttempt.cause, firstHubCloseAtUTC: trace.firstCloseAttempt.atUTC,
        } : {}),
      });
    });
  }

  accepted(ws: WebSocket, generation: number): void {
    const trace = this.traces.get(ws)!;
    trace.generation = generation;
    this.write("connection_accepted", trace);
  }

  rejected(ws: WebSocket, cause: "server_stopping" | "duplicate_identity", occupying?: WebSocket): void {
    const occupant = occupying ? this.traces.get(occupying) : undefined;
    this.write("connection_rejected", this.traces.get(ws)!, {
      cause,
      ...(occupant ? {
        occupyingConnectionId: occupant.connectionId, occupyingGeneration: occupant.generation,
        occupyingSocketState: this.socketState(occupant.ws), occupyingHelloAccepted: occupant.helloAccepted,
        occupyingWatchdogResetAgeMs: ageMs(performance.now(), occupant.watchdogResetAt),
      } : {}),
    });
  }

  helloAccepted(ws: WebSocket): void {
    const trace = this.traces.get(ws)!;
    trace.helloAccepted = true;
    this.write("hello_accepted", trace);
  }

  watchdogReset(ws: WebSocket, kind: WatchdogResetKind): void {
    const trace = this.traces.get(ws)!;
    trace.watchdogResetAt = performance.now();
    trace.watchdogResetKind = kind;
  }

  closeRequested(ws: WebSocket, requestedCode: number, cause: CloseCause, timeoutMs?: number): void {
    const trace = this.traces.get(ws)!;
    trace.firstCloseAttempt ??= { cause, atUTC: new Date().toISOString() };
    this.write("close_requested", trace, { requestedCode, cause, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  }

  released(ws: WebSocket, cause: ReleaseCause, replacement?: WebSocket): void {
    this.write("node_slot_released", this.traces.get(ws)!, {
      cause, ...(replacement ? { replacementConnectionId: this.traces.get(replacement)!.connectionId } : {}),
    });
  }

  socketError(ws: WebSocket): void {
    const trace = this.traces.get(ws)!;
    if (trace.errorSeen) return;
    trace.errorSeen = true;
    this.write("socket_error", trace);
  }

  private socketState(ws: WebSocket): string {
    return SOCKET_STATES[ws.readyState] ?? "unknown";
  }

  private write(event: LifecycleEvent, trace: Trace, fields: EventFields = {}): void {
    const now = performance.now();
    console.log(JSON.stringify({
      schemaVersion: 1, event, atUTC: new Date().toISOString(), eventSequence: ++this.eventSequence,
      hubId: this.hubId, connectionId: trace.connectionId, nodeId: trace.nodeId, generation: trace.generation,
      socketState: this.socketState(trace.ws), sourceRevision: this.sourceRevision,
      connectionAgeMs: ageMs(now, trace.connectedAt), helloAccepted: trace.helloAccepted,
      watchdogResetAgeMs: ageMs(now, trace.watchdogResetAt), watchdogResetKind: trace.watchdogResetKind,
      ...fields,
    }));
  }
}
