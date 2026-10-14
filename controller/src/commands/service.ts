import { randomUUID } from "node:crypto";
import { NodeHub } from "../nodes/hub.js";
import { ConflictError, IStore } from "../store/interface.js";
import { CommandRecord, PostCommandRequest, PostCommandRequestSchema, SendRoute } from "../types.js";
import { hasSkillRefs, sameSkillRefs } from "../skills/catalog.js";
import { selectSendRoute } from "../sessions/send-eligibility.js";

export class CommandError extends Error {
  constructor(public readonly httpStatus: number, message: string) { super(message); }
}

/** One dispatch path for HTTP clients, natural-language routing and the Leader. */
export class CommandService {
  constructor(private store: IStore, private hub: Pick<NodeHub, "isNodeConnected" | "getNodeSession" | "getNodeSkills" | "registerCommandResultWaiter" | "sendCommand">, private ttlSeconds: number, private readonly onStatusChanged?: () => void) {}

  /** Read-only scheduling gate. A false result must not consume a durable dispatch attempt. */
  canDispatchSend(target: Pick<PostCommandRequest, "nodeId" | "sessionId" | "skills">, expectedRoute: SendRoute): boolean {
    try {
      this.targetRoute({ ...target, action: "send" }, expectedRoute);
      return true;
    } catch (error) {
      if (error instanceof CommandError) return false;
      throw error;
    }
  }

  private targetRoute(request: Pick<PostCommandRequest, "nodeId" | "sessionId" | "action" | "skills">, expectedRoute?: SendRoute): SendRoute | undefined {
    if (!this.hub.isNodeConnected(request.nodeId)) throw new CommandError(503, "Target node is offline");
    const session = this.hub.getNodeSession(request.nodeId, request.sessionId);
    if (!session) throw new CommandError(404, "Target session is unavailable");
    let sendRoute: SendRoute | undefined;
    if (request.action === "send") {
      const eligibility = selectSendRoute(session);
      if (!eligibility.ready) throw new CommandError(eligibility.httpStatus, eligibility.reason);
      sendRoute = eligibility.route;
      if (expectedRoute !== undefined && sendRoute !== expectedRoute) throw new CommandError(409, "Target send route changed; regenerate the plan");
    } else if (!session.capabilities.includes("read")) {
      throw new CommandError(400, "Target does not support this action");
    }
    if (request.skills?.length && !hasSkillRefs(this.hub.getNodeSkills(request.nodeId), request.skills)) throw new CommandError(409, "Selected skill unavailable or changed");
    return sendRoute;
  }

  async submit(input: PostCommandRequest, waitMs = 5000, assertDispatchAllowed?: () => Promise<void>, expectedRoute?: SendRoute): Promise<CommandRecord> {
    const parsed = PostCommandRequestSchema.safeParse(input);
    if (!parsed.success) throw new CommandError(400, "Invalid command request");
    const request = parsed.data;
    if (request.action === "read" && expectedRoute !== undefined) throw new CommandError(400, "Read commands cannot carry a send route");
    const previous = await this.store.findCommandByRequestId(request.requestId);
    if (previous) {
      if (previous.nodeId !== request.nodeId || previous.sessionId !== request.sessionId ||
          previous.action !== request.action || (previous.prompt ?? "") !== (request.prompt ?? "") || !sameSkillRefs(previous.skills, request.skills)) {
        throw new ConflictError("Request ID already used with different command payload");
      }
      await this.store.markExpiredActiveCommandsUncertain();
      return (await this.store.getCommand(previous.commandId))!;
    }
    const sendRoute = this.targetRoute(request, expectedRoute);
    const now = new Date();
    const record: CommandRecord = {
      ...request, commandId: `cmd_${randomUUID()}`, status: "pending",
      ...(sendRoute ? { sendRoute } : {}),
      createdAt: now.toISOString(), updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlSeconds * 1000).toISOString(),
    };
    const created = await this.store.createCommandIfAbsent(record);
    if (!created.created) return created.command;
    this.onStatusChanged?.();
    const waiter = this.hub.registerCommandResultWaiter(record.commandId, waitMs);
    try {
      if (assertDispatchAllowed) {
        try { await assertDispatchAllowed(); }
        catch (error) {
          await this.store.updateCommandStatus(record.commandId, "failed", undefined, "Dispatch authority expired before transmission");
          throw error;
        }
      }
      if (request.action === "send") {
        if (!sendRoute || !this.canDispatchSend(request, sendRoute) || Date.parse(record.expiresAt) <= Date.now()) {
          const reason = "Target send route or authority changed before transmission";
          await this.store.updateCommandStatus(record.commandId, "failed", undefined, reason);
          throw new CommandError(409, reason);
        }
      }
      const delivery = await this.hub.sendCommand({
        type: "command", commandId: record.commandId, nodeId: request.nodeId,
        sessionId: request.sessionId, action: request.action, prompt: request.prompt, expiresAt: record.expiresAt, skills: request.skills,
        ...(sendRoute ? { sendRoute } : {}),
      });
      if (!delivery.delivered) {
        await this.store.updateCommandStatus(record.commandId, "uncertain", undefined, "Transport did not confirm command delivery");
      } else if (waitMs > 0) {
        await waiter.wait();
      }
      return (await this.store.getCommand(record.commandId))!;
    } finally {
      waiter.cancel();
      this.onStatusChanged?.();
    }
  }
}
