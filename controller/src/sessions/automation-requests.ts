import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { z } from "zod";
import { AUTOMATION_READ_TIMEOUT_MS, AutomationError, AutomationInspectionSchema, AutomationInspectOptionsSchema,
  MAX_SOURCE_AUTOMATIONS, SourceAutomationSchema, type AutomationInspection, type AutomationInspectOptions, type SourceAutomation } from "./automation-contracts.js";
const MAX_WIRE_BYTES = 768 * 1024;
const EnvelopeSchema = z.object({ type: z.literal("automation_response"), requestId: z.string().uuid(),
  automations: z.array(SourceAutomationSchema).max(MAX_SOURCE_AUTOMATIONS).optional(), inspection: AutomationInspectionSchema.optional(),
  error: z.string().max(256).optional(), }).strict();
type Response = z.infer<typeof EnvelopeSchema>;
const MAX_ACTIVE_REQUESTS = 16;
const MAX_NODE_ACTIVE_REQUESTS = 4;
const MAX_QUEUED_REQUESTS = 128;
const QUEUE_TIMEOUT_MS = 4 * 60_000;
interface Request {
  requestId: string;
  nodeId: string;
  ws: WebSocket;
  start(): void;
  settle(value?: Response, error?: AutomationError): void;
}
export class AutomationRequests {
  private pending = new Map<string, Request>();
  private queued: Request[] = [];
  private draining = false;

  // Scan in arrival order, allowing other nodes to progress while a node is full.
  private drain(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      for (let index = 0; index < this.queued.length && this.pending.size < MAX_ACTIVE_REQUESTS;) {
        const entry = this.queued[index];
        if ([...this.pending.values()].filter(p => p.nodeId === entry.nodeId).length >= MAX_NODE_ACTIVE_REQUESTS) {
          index++;
          continue;
        }
        this.queued.splice(index, 1);
        this.pending.set(entry.requestId, entry);
        entry.start();
      }
    } finally {
      this.draining = false;
    }
  }

  private request(nodeId: string, ws: WebSocket, args: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    if (signal?.aborted) return Promise.reject(new AutomationError(499, "automation_cancelled"));
    if (ws.readyState !== WebSocket.OPEN) return Promise.reject(new AutomationError(503, "automation_disconnected"));
    if (this.queued.length >= MAX_QUEUED_REQUESTS) return Promise.reject(new AutomationError(429, "automation_busy"));
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      let done = false;
      let started = false;
      let timer: ReturnType<typeof setTimeout>;
      const cancel = (code: string, status: number) => {
        if (done) return;
        // Queued reads have no remote operation to cancel.
        if (started && ws.readyState === WebSocket.OPEN) {
          try { ws.send(JSON.stringify({type:"cancel_automation",requestId,nodeId}), error => { if (error) console.warn("[automation] cancellation failed"); }); }
          catch { console.warn("[automation] cancellation failed"); }
        }
        entry.settle(undefined, new AutomationError(status, code));
      };
      const abort = () => cancel("automation_cancelled", 499);
      const entry: Request = {requestId,nodeId,ws,
        start: () => {
          if (done) return;
          clearTimeout(timer);
          if (ws.readyState !== WebSocket.OPEN) {
            entry.settle(undefined, new AutomationError(503,"automation_disconnected"));
            return;
          }
          started = true;
          timer = setTimeout(() => cancel("automation_timeout",504), AUTOMATION_READ_TIMEOUT_MS);
          try { ws.send(JSON.stringify({...args,nodeId,requestId}), error => {if (error) entry.settle(undefined,new AutomationError(503,"automation_disconnected"));}); }
          catch {entry.settle(undefined,new AutomationError(503,"automation_disconnected"));}
        },
        settle: (value,error) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort",abort);
          this.pending.delete(requestId);
          const index = this.queued.indexOf(entry);
          if (index !== -1) this.queued.splice(index,1);
          if (error) reject(error); else if (value) resolve(value); else reject(new AutomationError(502,"automation_invalid_response"));
          queueMicrotask(() => this.drain());
        },
      };
      timer = setTimeout(() => entry.settle(undefined,new AutomationError(504,"automation_queue_timeout")), QUEUE_TIMEOUT_MS);
      this.queued.push(entry);
      signal?.addEventListener("abort",abort,{once:true});
      this.drain();
    });
  }
  async list(nodeId: string, ws: WebSocket, signal?: AbortSignal): Promise<SourceAutomation[]> {
    const result = await this.request(nodeId,ws,{type:"list_automations"},signal);
    if (!result.automations || result.inspection || new Set(result.automations.map(a=>a.id)).size !== result.automations.length)
      throw new AutomationError(502,"automation_invalid_response");
    return result.automations;
  }
  async inspect(nodeId: string, ws: WebSocket, options: AutomationInspectOptions, signal?: AbortSignal): Promise<AutomationInspection> {
    const args = AutomationInspectOptionsSchema.parse(options);
    const result = await this.request(nodeId,ws,{type:"inspect_automation",...args},signal);
    if (!result.inspection || result.automations || result.inspection.automationId !== args.automationId ||
      result.inspection.expectedAt !== args.expectedAt || result.inspection.notAfter !== args.notAfter) throw new AutomationError(502,"automation_invalid_response");
    return result.inspection;
  }
  receive(nodeId: string, ws: WebSocket, raw: unknown): boolean {
    if (!raw || typeof raw !== "object") return false;
    const id = (raw as Record<string,unknown>).requestId; if (typeof id !== "string") return false;
    const entry = this.pending.get(id); if (!entry || entry.nodeId !== nodeId || entry.ws !== ws) return false;
    const parsed = Buffer.byteLength(JSON.stringify(raw)) <= MAX_WIRE_BYTES ? EnvelopeSchema.safeParse(raw) : undefined;
    if (!parsed?.success) {entry.settle(undefined,new AutomationError(502,"automation_invalid_response")); return false;}
    if (parsed.data.error) entry.settle(undefined,new AutomationError(502,parsed.data.error)); else entry.settle(parsed.data);
    return true;
  }
  disconnect(ws: WebSocket) {
    for (const entry of [...this.pending.values(),...this.queued])
      if(entry.ws===ws) entry.settle(undefined,new AutomationError(503,"automation_disconnected"));
  }
  closeAll() {
    for (const entry of [...this.pending.values(),...this.queued])
      entry.settle(undefined,new AutomationError(503,"automation_disconnected"));
  }
}
