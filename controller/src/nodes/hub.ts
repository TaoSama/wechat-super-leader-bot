import { WebSocket } from "ws";
import { AutomationRequests } from "../sessions/automation-requests.js";
import { AutomationError, AutomationInspectOptionsSchema, type AutomationInspectOptions, type AutomationInspection, type SourceAutomation } from "../sessions/automation-contracts.js";
import {
  ControllerCommandMessage,
  DaemonMessage,
  DaemonMessageSchema,
  DaemonResultMessage,
  HistoryReadOptions,
  NodeStatus,
  ScopedSession,
  Session,
  SessionHistory,
  MAX_DAEMON_CONTROL_MESSAGE_BYTES,
} from "../types.js";
import { IStore } from "../store/interface.js";
import { Skill } from "../skills/catalog.js";
import { HistoryError, SessionHistoryRequests } from "../sessions/history.js";
import { SessionMediaRequests } from "../sessions/media.js";
import { MediaError, type MediaListing, type MediaDescriptor } from "../sessions/media-contracts.js";
import { isTerminalSession } from "../sessions/terminal.js";
import { validateCommandTurnBinding } from "../store/command-state.js";
import { sameInputReceipt } from "../sessions/input-receipt.js";
import { InvalidSessionInventoryError, validateNodeSessionInventory } from "../store/node-sessions.js";

export interface ConnectedNode {
  nodeId: string;
  ws: WebSocket;
  connectedAt: Date;
  lastHeartbeat: Date;
  sessions: Session[];
  skills: Skill[];
  isHelloCompleted: boolean;
  heartbeatTimer?: NodeJS.Timeout;
  inspection?: { commandId: string; turnId?: string; deadline: number };
  inspectionCursor?: string;
  reconciling?: boolean;
}

export class NodeHub {
  private nodes = new Map<string, ConnectedNode>(); // nodeId -> ConnectedNode
  private store: IStore;
  private tokenToNode: Map<string, string>;
  private historyRequests = new SessionHistoryRequests();
  private mediaRequests = new SessionMediaRequests();
  private automationRequests = new AutomationRequests();

  async listAutomations(nodeId: string, signal?: AbortSignal): Promise<SourceAutomation[]> {
    const node = this.nodes.get(nodeId);
    if (!node || !this.isNodeConnected(nodeId)) throw new AutomationError(503, "automation_offline");
    return this.automationRequests.list(nodeId, node.ws, signal);
  }

  async inspectAutomation(nodeId: string, options: AutomationInspectOptions, signal?: AbortSignal): Promise<AutomationInspection> {
    const args = AutomationInspectOptionsSchema.parse(options);
    const node = this.nodes.get(nodeId);
    if (!node || !this.isNodeConnected(nodeId)) return {...args,status:"unknown",sources:[],observedAt:Date.now(),reason:"node_offline"};
    try { return await this.automationRequests.inspect(nodeId,node.ws,args,signal); }
    catch (error) {
      if (!(error instanceof AutomationError) || error.code === "automation_cancelled") throw error;
      return {...args,status:"unknown",sources:[],observedAt:Date.now(),reason:error.code};
    }
  }

  private mediaNode(nodeId: string, sessionId: string): ConnectedNode {
    const node = this.nodes.get(nodeId);
    if (!node || !node.isHelloCompleted || node.ws.readyState !== WebSocket.OPEN) throw new MediaError(503, "media_offline");
    const session = node.sessions.find(item => item.id === sessionId);
    if (!session || !session.capabilities.includes("read") || isTerminalSession(session)) throw new MediaError(403, "media_forbidden");
    return node;
  }

  listMedia(nodeId: string, sessionId: string, signal?: AbortSignal): Promise<MediaListing> {
    return this.mediaRequests.list({ nodeId, sessionId }, this.mediaNode(nodeId, sessionId).ws, signal);
  }

  readMedia(nodeId: string, sessionId: string, listing: MediaListing, image: MediaDescriptor, signal?: AbortSignal): Promise<Buffer> {
    return this.mediaRequests.read({ nodeId, sessionId }, this.mediaNode(nodeId, sessionId).ws, listing, image, signal);
  }

  // Callbacks for command results: commandId -> callback
  private commandResultWaiters = new Map<
    string,
    (res: DaemonResultMessage | null) => void
  >();

  // Monotonic generation counter per nodeId to prevent async disconnect/reconnect races
  private nodeGenerations = new Map<string, number>();
  private nodeSessionWrites = new Map<string, Promise<void>>();
  private sessionSubscribers = new Map<string, Set<() => void>>();

  // Maximum heartbeat timeout: if no heartbeat received for 45s, close connection
  private static readonly HEARTBEAT_TIMEOUT_MS = 45000;
  private static readonly INSPECTION_TIMEOUT_MS = 20000;

  constructor(store: IStore, tokenToNode: Map<string, string>, private readonly onStatusChanged?: () => void) {
    this.store = store;
    this.tokenToNode = tokenToNode;
  }

  authenticateToken(token: string): string | null {
    return this.tokenToNode.get(token) || null;
  }

  isNodeConnected(nodeId: string): boolean {
    const node = this.nodes.get(nodeId);
    return !!node && node.isHelloCompleted && node.ws.readyState === WebSocket.OPEN;
  }

  getNodeSession(nodeId: string, sessionId: string): Session | null {
    const node = this.nodes.get(nodeId);
    if (!node || !node.isHelloCompleted) return null;
    return node.sessions.find((s) => s.id === sessionId) || null;
  }

  subscribeSessionChanges(nodeId: string, listener: () => void): () => void {
    const listeners = this.sessionSubscribers.get(nodeId) ?? new Set<() => void>();
    listeners.add(listener);
    this.sessionSubscribers.set(nodeId, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size && this.sessionSubscribers.get(nodeId) === listeners) this.sessionSubscribers.delete(nodeId);
    };
  }

  private sessionsChanged(nodeId: string): void {
    for (const listener of [...(this.sessionSubscribers.get(nodeId) ?? [])]) listener();
  }

  async readHistory(nodeId: string, sessionId: string, options: HistoryReadOptions = {},
    signal?: AbortSignal): Promise<SessionHistory> {
    const node = this.nodes.get(nodeId);
    if (!node || !node.isHelloCompleted || node.ws.readyState !== WebSocket.OPEN) {
      throw new HistoryError(503, "history_offline", "History node is offline");
    }
    const session = node.sessions.find(session => session.id === sessionId);
    if (!session) {
      throw new HistoryError(404, "history_session_not_found", "Session not found");
    }
    return this.historyRequests.read(nodeId, sessionId, node.ws, options, signal, session);
  }

  handleConnection(ws: WebSocket, nodeId: string): void {
    // Contract: Reject duplicate live node identities
    const existing = this.nodes.get(nodeId);
    if (existing && existing.ws.readyState === WebSocket.OPEN) {
      ws.close(4009, `Node identity '${nodeId}' is already actively connected`);
      return;
    }

    const currentGen = (this.nodeGenerations.get(nodeId) || 0) + 1;
    this.nodeGenerations.set(nodeId, currentGen);

    const nodeRecord: ConnectedNode = {
      nodeId,
      ws,
      connectedAt: new Date(),
      lastHeartbeat: new Date(),
      sessions: [],
      skills: [],
      isHelloCompleted: false,
    };
    this.nodes.set(nodeId, nodeRecord);

    const resetHeartbeatWatchdog = () => {
      if (nodeRecord.heartbeatTimer) clearTimeout(nodeRecord.heartbeatTimer);
      nodeRecord.heartbeatTimer = setTimeout(() => {
        console.warn(`[${nodeId}] Heartbeat timeout exceeded (${NodeHub.HEARTBEAT_TIMEOUT_MS}ms). Closing socket.`);
        ws.close(4008, "Heartbeat timeout");
      }, NodeHub.HEARTBEAT_TIMEOUT_MS);
    };

    resetHeartbeatWatchdog();

    ws.on("message", async (data: Buffer | string) => {
      // Guard: Ensure message belongs to currently active socket
      if (this.nodes.get(nodeId)?.ws !== ws) {
        return;
      }

      try {
        const text = typeof data === "string" ? data : data.toString("utf8");
        const json = JSON.parse(text);
        if (json?.type !== "result" && Buffer.byteLength(text,"utf8") > MAX_DAEMON_CONTROL_MESSAGE_BYTES) {
          ws.close(4000,"Daemon control message exceeds limit"); return;
        }
        if (json?.type === "history" && nodeRecord.isHelloCompleted) {
          if (this.historyRequests.receive(nodeId, ws, json)) resetHeartbeatWatchdog();
          return;
        }
        if ((json?.type === "media_list" || json?.type === "media_chunk") && nodeRecord.isHelloCompleted) {
          if (this.mediaRequests.receive(nodeId, ws, json)) resetHeartbeatWatchdog();
          return;
        }
        if (json?.type === "automation_response" && nodeRecord.isHelloCompleted) {
          if (this.automationRequests.receive(nodeId,ws,json)) resetHeartbeatWatchdog();
          return;
        }
        const parseResult = DaemonMessageSchema.safeParse(json);
        if (!parseResult.success) {
          console.error(`[${nodeId}] invalid daemon message schema:`, parseResult.error.format());
          if (json?.type === "heartbeat" || json?.type === "hello") {
            // An invalid inventory must revoke cached send authority immediately.
            nodeRecord.sessions = [];
            this.sessionsChanged(nodeId);
            ws.close(4000, "Invalid session inventory");
          }
          return;
        }

        const msg: DaemonMessage = parseResult.data;
        if (msg.type === "hello" || msg.type === "heartbeat") {
          try {
            validateNodeSessionInventory(msg.sessions);
          } catch (error) {
            if (!(error instanceof InvalidSessionInventoryError)) throw error;
            console.warn(`[${nodeId}] Rejected duplicate session identities in inventory`);
            nodeRecord.sessions = [];
            this.sessionsChanged(nodeId);
            ws.close(4000, "Invalid session inventory");
            return;
          }
        }
        resetHeartbeatWatchdog();
        await this.handleDaemonMessage(nodeRecord, msg);
        this.onStatusChanged?.();
      } catch (err) {
        console.error(`[${nodeId}] error handling message:`, err);
      }
    });

    ws.on("close", async () => {
      if (nodeRecord.heartbeatTimer) clearTimeout(nodeRecord.heartbeatTimer);
      this.historyRequests.disconnect(ws);
      this.mediaRequests.disconnect(ws);
      this.automationRequests.disconnect(ws);
      if (this.nodes.get(nodeId)?.ws === ws) {
        this.nodes.delete(nodeId);
        this.sessionsChanged(nodeId);

        await this.queueNodeSessionWrite(nodeId, async () => {
          try {
            await this.store.removeNodeSessions(nodeId);
          } catch (err) {
            console.error(`[${nodeId}] Error removing node sessions on disconnect:`, err);
          }
          // Check after persistence: a queued cleanup must not revoke a new generation.
          if (this.nodeGenerations.get(nodeId) === currentGen) {
            try {
              await this.store.markNodeActiveCommandsUncertain(nodeId, "Node disconnected after dispatch");
            } catch (err) {
              console.error(`[${nodeId}] Error marking active commands uncertain on disconnect:`, err);
            }
          }
        });
        this.onStatusChanged?.();
      }
    });

    ws.on("error", (err) => {
      this.historyRequests.disconnect(ws);
      this.mediaRequests.disconnect(ws);
      this.automationRequests.disconnect(ws);
      console.error(`[${nodeId}] ws error:`, err);
    });
  }

  private async handleDaemonMessage(node: ConnectedNode, msg: DaemonMessage): Promise<void> {
    const nodeId = node.nodeId;

    if (msg.type === "hello") {
      // Reject repeated hello
      if (node.isHelloCompleted) {
        console.error(`[${nodeId}] Repeated hello received. Closing socket.`);
        node.ws.close(4000, "Repeated hello message rejected");
        return;
      }

      if (msg.nodeId !== nodeId) {
        console.error(`[${nodeId}] Node reported mismatched nodeId in hello: ${msg.nodeId}`);
        node.ws.close(4003, "Node ID mismatch with authenticated identity");
        return;
      }

      node.sessions = msg.sessions;
      node.skills = msg.skills;
      node.lastHeartbeat = new Date();
      node.isHelloCompleted = true;
      this.sessionsChanged(nodeId);
      try {
        await this.persistNodeSessions(node, msg.sessions);
      } catch (err) {
        console.error(`[${nodeId}] Error upserting node sessions on hello:`, err);
      }
      await this.reconcileTurn(node);
      return;
    }

    // Reject any heartbeat or result before hello is completed
    if (!node.isHelloCompleted) {
      console.error(`[${nodeId}] Received ${msg.type} before hello handshake completed. Closing socket.`);
      node.ws.close(4002, "Message before hello handshake");
      return;
    }

    if (msg.type === "heartbeat") {
      node.sessions = msg.sessions;
      node.skills = msg.skills;
      node.lastHeartbeat = new Date();
      this.sessionsChanged(nodeId);
      try {
        await this.persistNodeSessions(node, msg.sessions);
      } catch (err) {
        console.error(`[${nodeId}] Error upserting node sessions on heartbeat:`, err);
      }
      await this.reconcileTurn(node);
    } else if (msg.type === "result") {
      // Validate command exists and belongs to this nodeId
      let cmd;
      try {
        cmd = await this.store.getCommand(msg.commandId);
      } catch (err) {
        console.error(`[${nodeId}] Error fetching command ${msg.commandId}:`, err);
        return;
      }

      // The socket may have closed or been replaced while storage was pending.
      // Its durable receipt can be replayed by the current connection instead.
      if (this.nodes.get(nodeId) !== node || node.ws.readyState !== WebSocket.OPEN) return;

      if (!cmd) {
        console.warn(`[${nodeId}] Received result for non-existent commandId '${msg.commandId}'`);
        return;
      }

      if (cmd.nodeId !== nodeId) {
        console.error(
          `[${nodeId}] Security violation: Node attempted to update command '${msg.commandId}' belonging to node '${cmd.nodeId}'`
        );
        return;
      }

      try {
        validateCommandTurnBinding(cmd, msg.status, msg.turnId, msg.inputReceipt, msg.output, msg.error);
      } catch {
        console.warn(`[${nodeId}] Rejected mismatched turn result for ${msg.commandId}`);
        return;
      }

      // Update command in store
      try {
        await this.store.updateCommandStatus(
          msg.commandId,
          msg.status,
          msg.output,
          msg.error,
          msg.turnId,
          msg.inputReceipt
        );
      } catch (err) {
        console.error(`[${nodeId}] Error updating command status ${msg.commandId}:`, err);
        return; // No acknowledgement or waiter notification before persistence.
      }

      if (node.inspection?.commandId === msg.commandId && node.inspection.turnId === msg.turnId) {
        node.inspection = undefined;
      }
      if (this.nodes.get(nodeId) !== node || node.ws.readyState !== WebSocket.OPEN) return;
      const persisted = await this.store.getCommand(msg.commandId);
      if (this.nodes.get(nodeId) !== node || node.ws.readyState !== WebSocket.OPEN) return;
      if (!persisted) return;
      if (cmd.sendRoute === "terminal-pane" && persisted.status !== msg.status) return;
      if (msg.status === "input-written" && (persisted.status !== "input-written" || !persisted.inputReceipt ||
          !msg.inputReceipt || !sameInputReceipt(persisted.inputReceipt, msg.inputReceipt))) return;
      node.ws.send(JSON.stringify({ type: "result_ack", commandId: msg.commandId, turnId: msg.turnId, status: msg.status,
        ...(msg.status === "input-written" ? { inputReceipt: persisted.inputReceipt } : {}) }), error => {
        if (error) console.warn(`[${nodeId}] Result acknowledgement transport failed`);
      });

      // Notify waiter if any
      const waiter = this.commandResultWaiters.get(msg.commandId);
      if (waiter) {
        if (persisted) waiter({ type: "result", commandId: persisted.commandId,
          status: ["pending","queued","cancelled","expired"].includes(persisted.status) ? "uncertain" : persisted.status as DaemonResultMessage["status"],
          turnId: persisted.turnId, inputReceipt: persisted.inputReceipt, output: persisted.output, error: persisted.error });
      }
    }
  }

  /** Only inventory persistence is queued; history and exact receipts remain independent. */
  private queueNodeSessionWrite(nodeId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.nodeSessionWrites.get(nodeId);
    // The caller reports each failure. A failed write must not poison the next inventory.
    const write = previous ? previous.then(operation, operation) : Promise.resolve().then(operation);
    this.nodeSessionWrites.set(nodeId, write);
    const release = () => {
      if (this.nodeSessionWrites.get(nodeId) === write) this.nodeSessionWrites.delete(nodeId);
    };
    write.then(release, release);
    return write;
  }

  private persistNodeSessions(node: ConnectedNode, sessions: Session[]): Promise<void> {
    return this.queueNodeSessionWrite(node.nodeId, async () => {
      if (this.nodes.get(node.nodeId) !== node || node.ws.readyState !== WebSocket.OPEN) return;
      await this.store.upsertNodeSessions(node.nodeId, sessions);
    });
  }

  /** One bounded read-only query per heartbeat. A cursor prevents unavailable turns starving others. */
  private async reconcileTurn(node: ConnectedNode): Promise<void> {
    if (node.reconciling || (node.inspection && node.inspection.deadline > Date.now())) return;
    node.reconciling = true;
    try {
      let candidates = await this.store.listInspectableCommands(node.nodeId, 1, node.inspectionCursor);
      if (!candidates.length && node.inspectionCursor) {
        node.inspectionCursor = undefined;
        candidates = await this.store.listInspectableCommands(node.nodeId, 1);
      }
      if (this.nodes.get(node.nodeId) !== node || node.ws.readyState !== WebSocket.OPEN) return;
      const cmd = candidates[0];
      if (!cmd || cmd.sendRoute === "terminal-pane" || cmd.sessionId.startsWith("terminal:") || cmd.inputReceipt) return;
      node.inspectionCursor = cmd.commandId;
      const inspection = { commandId: cmd.commandId, turnId: cmd.turnId, deadline: Date.now() + NodeHub.INSPECTION_TIMEOUT_MS };
      node.inspection = inspection;
      const message = cmd.turnId ? { type: "inspect_turn", commandId: cmd.commandId,
        nodeId: cmd.nodeId, sessionId: cmd.sessionId, turnId: cmd.turnId } : {
        type:"inspect_command",commandId:cmd.commandId,nodeId:cmd.nodeId,sessionId:cmd.sessionId,action:cmd.action,
        prompt:cmd.prompt,expiresAt:cmd.expiresAt,skills:cmd.skills,sendRoute:cmd.sendRoute,
        deliveryMode:cmd.deliveryMode,expectedTurnId:cmd.expectedTurnId};
      node.ws.send(JSON.stringify(message), error => {
        if (error) {
          if (node.inspection === inspection) node.inspection = undefined;
          console.warn(`[${node.nodeId}] Turn inspection transport failed`);
        }
      });
    } catch {
      console.warn(`[${node.nodeId}] Turn reconciliation unavailable; will retry on heartbeat`);
    } finally {
      node.reconciling = false;
    }
  }

  registerCommandResultWaiter(
    commandId: string,
    timeoutMs = 15000
  ): {
    wait: () => Promise<DaemonResultMessage | null>;
    cancel: () => void;
  } {
    this.commandResultWaiters.get(commandId)?.(null);
    let timer: NodeJS.Timeout | undefined;
    let settle!: (res: DaemonResultMessage | null) => void;
    const waitPromise = new Promise<DaemonResultMessage | null>((resolve) => {
      settle = (res) => {
        if (timer) clearTimeout(timer);
        if (this.commandResultWaiters.get(commandId) === settle) {
          this.commandResultWaiters.delete(commandId);
        }
        resolve(res);
      };
      timer = setTimeout(() => settle(null), timeoutMs);
      this.commandResultWaiters.set(commandId, settle);
    });

    return {
      wait: () => waitPromise,
      cancel: () => settle(null),
    };
  }

  async sendCommand(
    cmd: ControllerCommandMessage
  ): Promise<{ delivered: boolean; error?: string }> {
    const node = this.nodes.get(cmd.nodeId);
    if (!node || !node.isHelloCompleted || node.ws.readyState !== WebSocket.OPEN) {
      return { delivered: false, error: `Node '${cmd.nodeId}' is not connected` };
    }

    return new Promise<{ delivered: boolean; error?: string }>((resolve) => {
      try {
        node.ws.send(JSON.stringify(cmd), (err) => {
          if (err) {
            resolve({ delivered: false, error: err.message });
          } else {
            resolve({ delivered: true });
          }
        });
      } catch (err: any) {
        resolve({ delivered: false, error: err.message });
      }
    });
  }

  getNodeStatusList(): NodeStatus[] {
    const list: NodeStatus[] = [];
    for (const [nodeId, node] of this.nodes.entries()) {
      list.push({
        nodeId,
        connected: node.isHelloCompleted && node.ws.readyState === WebSocket.OPEN,
        lastHeartbeat: node.lastHeartbeat.toISOString(),
        sessionCount: node.sessions.length,
      });
    }
    return list;
  }

  async getAllSessions(): Promise<ScopedSession[]> {
    const all: ScopedSession[] = [];
    for (const [nodeId, node] of this.nodes.entries()) {
      if (node.isHelloCompleted && node.ws.readyState === WebSocket.OPEN) {
        for (const s of node.sessions) {
          all.push({ ...s, nodeId });
        }
      }
    }
    return all;
  }

  getNodeSkills(nodeId: string): Skill[] {
    if (!this.isNodeConnected(nodeId)) return [];
    return structuredClone(this.nodes.get(nodeId)!.skills);
  }

  getAllSkills(): (Skill & { nodeId: string })[] {
    return [...this.nodes.keys()].flatMap(nodeId => this.getNodeSkills(nodeId).map(skill => ({ ...skill, nodeId })));
  }

  async closeAll(): Promise<void> {
    this.historyRequests.closeAll();
    this.mediaRequests.closeAll();
    this.automationRequests.closeAll();
    const closingNodes = [...this.nodes.entries()];
    this.nodes.clear();
    for (const [nodeId] of closingNodes) this.sessionsChanged(nodeId);
    for (const [nodeId, node] of closingNodes) {
      if (node.heartbeatTimer) clearTimeout(node.heartbeatTimer);
      try {
        node.ws.close(1001, "Server shutting down");
      } catch (err) {
        console.error(`[${nodeId}] Error closing websocket during closeAll:`, err);
      }
      try {
        await this.queueNodeSessionWrite(nodeId, () => this.store.removeNodeSessions(nodeId));
        await this.store.markNodeActiveCommandsUncertain(nodeId, "Controller shutting down; execution result unconfirmed");
      } catch (err) {
        console.error(`[${nodeId}] Error persisting shutdown uncertainty:`, err);
      }
    }
    // Disconnected nodes are already absent from `nodes`, but their complete
    // cleanup (including uncertain receipts) must finish before Store shutdown.
    const drained = await Promise.allSettled([...this.nodeSessionWrites.values()]);
    for (const result of drained) {
      if (result.status === "rejected") console.error("Error draining node inventory persistence on shutdown:", result.reason);
    }
    for (const settle of this.commandResultWaiters.values()) settle(null);
  }
}
