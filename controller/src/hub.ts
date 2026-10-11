import { WebSocket } from "ws";
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
} from "./types.js";
import { IStore } from "./store/interface.js";
import { Skill } from "./skills.js";
import { HistoryError, SessionHistoryRequests } from "./session-history.js";
import { validateCommandTurnBinding } from "./store/command-state.js";

export interface ConnectedNode {
  nodeId: string;
  ws: WebSocket;
  connectedAt: Date;
  lastHeartbeat: Date;
  sessions: Session[];
  skills: Skill[];
  isHelloCompleted: boolean;
  heartbeatTimer?: NodeJS.Timeout;
  inspection?: { commandId: string; turnId: string; deadline: number };
  inspectionCursor?: string;
  reconciling?: boolean;
}

export class NodeHub {
  private nodes = new Map<string, ConnectedNode>(); // nodeId -> ConnectedNode
  private store: IStore;
  private tokenToNode: Map<string, string>;
  private historyRequests = new SessionHistoryRequests();

  // Callbacks for command results: commandId -> callback
  private commandResultWaiters = new Map<
    string,
    (res: DaemonResultMessage | null) => void
  >();

  // Monotonic generation counter per nodeId to prevent async disconnect/reconnect races
  private nodeGenerations = new Map<string, number>();

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

  async readHistory(nodeId: string, sessionId: string, options: HistoryReadOptions = {},
    signal?: AbortSignal): Promise<SessionHistory> {
    const node = this.nodes.get(nodeId);
    if (!node || !node.isHelloCompleted || node.ws.readyState !== WebSocket.OPEN) {
      throw new HistoryError(503, "history_offline", "History node is offline");
    }
    if (!node.sessions.some(session => session.id === sessionId)) {
      throw new HistoryError(404, "history_session_not_found", "Session not found");
    }
    return this.historyRequests.read(nodeId, sessionId, node.ws, options, signal);
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
        if (json?.type === "history" && nodeRecord.isHelloCompleted) {
          if (this.historyRequests.receive(nodeId, ws, json)) resetHeartbeatWatchdog();
          return;
        }
        const parseResult = DaemonMessageSchema.safeParse(json);
        if (!parseResult.success) {
          console.error(`[${nodeId}] invalid daemon message schema:`, parseResult.error.format());
          if (json?.type === "heartbeat" || json?.type === "hello") {
            // An invalid inventory must revoke cached send authority immediately.
            nodeRecord.sessions = [];
            ws.close(4000, "Invalid session inventory");
          }
          return;
        }

        const msg: DaemonMessage = parseResult.data;
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
      if (this.nodes.get(nodeId)?.ws === ws) {
        this.nodes.delete(nodeId);

        try {
          // Remove stale sessions for this disconnected node
          await this.store.removeNodeSessions(nodeId);
        } catch (err) {
          console.error(`[${nodeId}] Error removing node sessions on disconnect:`, err);
        }

        // Only mark uncertain if a newer connection hasn't taken over in the meantime
        if (this.nodeGenerations.get(nodeId) === currentGen) {
          try {
            await this.store.markNodeActiveCommandsUncertain(
              nodeId,
              "Node disconnected after dispatch"
            );
          } catch (err) {
            console.error(`[${nodeId}] Error marking active commands uncertain on disconnect:`, err);
          }
        }
        this.onStatusChanged?.();
      }
    });

    ws.on("error", (err) => {
      this.historyRequests.disconnect(ws);
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
      try {
        await this.store.upsertNodeSessions(nodeId, msg.sessions);
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
      try {
        await this.store.upsertNodeSessions(nodeId, msg.sessions);
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
        validateCommandTurnBinding(cmd, msg.status, msg.turnId);
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
          msg.turnId
        );
      } catch (err) {
        console.error(`[${nodeId}] Error updating command status ${msg.commandId}:`, err);
        return; // No acknowledgement or waiter notification before persistence.
      }

      if (node.inspection?.commandId === msg.commandId && node.inspection.turnId === msg.turnId) {
        node.inspection = undefined;
      }
      if (this.nodes.get(nodeId) !== node || node.ws.readyState !== WebSocket.OPEN) return;
      node.ws.send(JSON.stringify({ type: "result_ack", commandId: msg.commandId, turnId: msg.turnId, status: msg.status }), error => {
        if (error) console.warn(`[${nodeId}] Result acknowledgement transport failed`);
      });

      // Notify waiter if any
      const waiter = this.commandResultWaiters.get(msg.commandId);
      if (waiter) {
        const persisted = await this.store.getCommand(msg.commandId);
        if (persisted) waiter({ type: "result", commandId: persisted.commandId,
          status: persisted.status === "pending" ? "uncertain" : persisted.status,
          turnId: persisted.turnId, output: persisted.output ?? "", error: persisted.error });
      }
    }
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
      if (!cmd?.turnId) return;
      node.inspectionCursor = cmd.commandId;
      const inspection = { commandId: cmd.commandId, turnId: cmd.turnId, deadline: Date.now() + NodeHub.INSPECTION_TIMEOUT_MS };
      node.inspection = inspection;
      node.ws.send(JSON.stringify({ type: "inspect_turn", commandId: cmd.commandId,
        nodeId: cmd.nodeId, sessionId: cmd.sessionId, turnId: cmd.turnId }), error => {
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
    const closingNodes = [...this.nodes.entries()];
    this.nodes.clear();
    for (const [nodeId, node] of closingNodes) {
      if (node.heartbeatTimer) clearTimeout(node.heartbeatTimer);
      try {
        node.ws.close(1001, "Server shutting down");
      } catch (err) {
        console.error(`[${nodeId}] Error closing websocket during closeAll:`, err);
      }
      try {
        await this.store.removeNodeSessions(nodeId);
        await this.store.markNodeActiveCommandsUncertain(nodeId, "Controller shutting down; execution result unconfirmed");
      } catch (err) {
        console.error(`[${nodeId}] Error persisting shutdown uncertainty:`, err);
      }
    }
    for (const settle of this.commandResultWaiters.values()) settle(null);
  }
}
