import { randomUUID } from "node:crypto";
import { NodeHub } from "../nodes/hub.js";
import { ConflictError, IStore } from "../store/interface.js";
import { CommandRecord, CommandAuthority, PostCommandRequest, PostCommandRequestSchema, SendRoute } from "../types.js";
import { hasSkillRefs } from "../skills/catalog.js";
import { selectSendRoute } from "../sessions/send-eligibility.js";
import { isTerminalSession } from "../sessions/terminal.js";
import { QUEUE_BATCH_SIZE, QUEUE_TICK_MS, queueSendRoute, sameAuthority, sameCommandPayload } from "./queue.js";
import { matchesExecutionCommand } from "../leader/plans/execution.js";
import { matchesGoalCommand } from "../leader/goals/goal.js";

export class CommandError extends Error {
  constructor(public readonly httpStatus: number, message: string) { super(message); }
}
type Hub = Pick<NodeHub, "isNodeConnected" | "getNodeSession" | "getNodeSkills" | "registerCommandResultWaiter" | "sendCommand">;

/** One durable submission path. Only an atomic queued claim permits a new mutation. */
export class CommandService {
  private timer?: ReturnType<typeof setInterval>;
  private tick?: Promise<void>;
  private cursor = "";
  constructor(private store: IStore, private hub: Hub, private ttlSeconds: number,
    private readonly onStatusChanged?: () => void, private readonly isChatAllowed: (chatId: string) => boolean = () => true) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.dispatchQueued().catch(error => console.error("Command queue dispatch failed", error)); }, QUEUE_TICK_MS);
    this.timer.unref?.();
  }
  async stop(): Promise<void> { if (this.timer) clearInterval(this.timer); this.timer = undefined; await this.tick; }

  canDispatchSend(target: Pick<PostCommandRequest, "nodeId" | "sessionId" | "skills" | "deliveryMode" | "expectedTurnId">, expectedRoute: SendRoute): boolean {
    try { this.targetRoute({ ...target, action: "send" }, expectedRoute); return true; }
    catch (error) { if (error instanceof CommandError) return false; throw error; }
  }

  private targetRoute(request: Pick<PostCommandRequest, "nodeId" | "sessionId" | "action" | "skills" | "deliveryMode" | "expectedTurnId">, expectedRoute?: SendRoute): SendRoute | undefined {
    if (!this.hub.isNodeConnected(request.nodeId)) throw new CommandError(503, "Target node is offline");
    const session = this.hub.getNodeSession(request.nodeId, request.sessionId);
    if (!session) throw new CommandError(404, "Target session is unavailable");
    if (request.skills?.length && !hasSkillRefs(this.hub.getNodeSkills(request.nodeId), request.skills)) throw new CommandError(409, "Selected skill unavailable or changed");
    if (request.action === "read") {
      if (!session.capabilities.includes("read")) throw new CommandError(400, "Target does not support this action");
      return undefined;
    }
    if (request.deliveryMode === "steer") {
      const route = queueSendRoute(session, expectedRoute);
      const observed = Date.parse(session.observedAt ?? "");
      if (!request.expectedTurnId || !route || route === "terminal-pane" || route === "app-server-resume" ||
          !Number.isFinite(observed) || observed > Date.now() || Date.now()-observed > 45000) throw new CommandError(409,"Exact active turn route is unavailable");
      return route;
    }
    const eligibility = selectSendRoute(session, Date.now(), expectedRoute);
    if (!eligibility.ready) throw new CommandError(eligibility.httpStatus, eligibility.reason);
    if (expectedRoute && eligibility.route !== expectedRoute) throw new CommandError(409,"Target send route changed; regenerate the plan");
    return eligibility.route;
  }

  async submit(input: PostCommandRequest, waitMs = 5000, assertDispatchAllowed?: () => Promise<void>, expectedRoute?: SendRoute,
    authority: CommandAuthority = { type: "admin" }): Promise<CommandRecord> {
    const parsed = PostCommandRequestSchema.safeParse(input);
    if (!parsed.success) throw new CommandError(400, "Invalid command request");
    const request = parsed.data;
    if (request.action === "read" && expectedRoute) throw new CommandError(400, "Read commands cannot carry a send route");
    const previous = await this.store.findCommandByRequestId(request.requestId);
    if (previous) {
      if (!sameCommandPayload(previous,request) || !sameAuthority(previous.authority,authority)) throw new ConflictError("Request ID already used with different command payload");
      await this.store.markExpiredActiveCommandsUncertain();
      return (await this.store.getCommand(previous.commandId))!;
    }
    let sendRoute: SendRoute | undefined;
    let readyAtSubmission = false;
    if (request.action === "send") {
      const session = this.hub.getNodeSession(request.nodeId,request.sessionId) ?? await this.store.getKnownSession(request.nodeId,request.sessionId);
      if (!session) throw new CommandError(404,"Target session is unknown");
      // Terminal input is never queued and retains its live-only qualification errors.
      if (isTerminalSession(session)) this.targetRoute(request,expectedRoute);
      sendRoute = queueSendRoute(session,expectedRoute);
      if (!sendRoute) throw new CommandError(expectedRoute ? 409 : 400,expectedRoute ? "Target send route changed; regenerate the plan" : "Target does not support this action");
      readyAtSubmission = this.canDispatchSend(request,sendRoute);
      if (sendRoute === "terminal-pane") this.targetRoute(request,sendRoute);
      if (request.skills?.length && this.hub.isNodeConnected(request.nodeId) && !hasSkillRefs(this.hub.getNodeSkills(request.nodeId),request.skills)) throw new CommandError(409,"Selected skill unavailable or changed");
    } else this.targetRoute(request);
    const now = new Date();
    const record: CommandRecord = { ...request, commandId:`cmd_${randomUUID()}`,status:request.action === "send" && sendRoute !== "terminal-pane" ? "queued" : "pending",
      ...(sendRoute ? {sendRoute,deliveryMode:request.deliveryMode ?? "next-turn",authority } : {}),
      createdAt:now.toISOString(),updatedAt:now.toISOString(),expiresAt:new Date(now.getTime()+this.ttlSeconds*1000).toISOString() };
    const created = await this.store.createCommandIfAbsent(record);
    if (!created.created) return created.command;
    this.onStatusChanged?.();
    try { await assertDispatchAllowed?.(); }
    catch (error) { await this.store.updateCommandStatus(record.commandId,"failed",undefined,"Dispatch authority expired before transmission"); throw error; }
    if (readyAtSubmission && sendRoute && !this.canDispatchSend(request,sendRoute)) {
      await this.store.updateCommandStatus(record.commandId,"failed",undefined,"Target send route or authority changed before transmission");
      throw new CommandError(409,"Target send route or authority changed before transmission");
    }
    if (request.action === "send" && sendRoute !== "terminal-pane") await this.dispatchOne(created.command,waitMs);
    else await this.transmit(record,waitMs);
    return (await this.store.getCommand(record.commandId))!;
  }

  async cancel(commandId: string, authority?: CommandAuthority): Promise<CommandRecord> {
    const command = await this.store.cancelQueuedCommand(commandId,authority);
    if (!command) throw new CommandError(409,"Command is no longer queued or belongs to another authorization");
    this.onStatusChanged?.(); return command;
  }
  get(commandId: string): Promise<CommandRecord | null> {return this.store.getCommand(commandId);}
  async getByRequestId(requestId: string, authority: CommandAuthority): Promise<CommandRecord | null> {
    const command = await this.store.findCommandByRequestId(requestId);
    return command && sameAuthority(command.authority, authority) ? command : null;
  }

  dispatchQueued(): Promise<void> {
    if (this.tick) return this.tick;
    this.tick = this.runQueue().finally(()=>{this.tick=undefined;});
    return this.tick;
  }
  private async runQueue(): Promise<void> {
    await this.store.markExpiredActiveCommandsUncertain();
    const records = await this.store.listQueuedCommands(QUEUE_BATCH_SIZE,this.cursor);
    this.cursor = records.length === QUEUE_BATCH_SIZE ? records.at(-1)!.commandId : "";
    for (const record of records) await this.dispatchOne(record,0);
  }
  private async authorized(record: CommandRecord): Promise<boolean> {
    const authority = record.authority;
    if (!authority || authority.type === "admin") return true;
    if (authority.type === "console") return Date.parse(authority.expiresAt)>Date.now() &&
      !!await this.store.getConsoleSession(authority.tokenHash,new Date().toISOString());
    if (!this.isChatAllowed(authority.chatId)) return false;
    if (authority.type === "chat") return true;
    if (authority.type === "plan") {
      const plan = await this.store.getExecution(authority.id);
      return !!plan && plan.chatId === authority.chatId && plan.status === "active" && plan.expiresAt>Date.now() &&
        plan.plan.actions.some((_,index)=>!!plan.attempts[index] && matchesExecutionCommand(plan,index,record));
    }
    const goal = await this.store.getGoal(authority.id);
    return !!goal && goal.chatId === authority.chatId && goal.status === "active" && goal.expiresAt>Date.now() &&
      goal.actions.some((_,index)=>!!goal.actions[index].attempt && matchesGoalCommand(goal,index,record));
  }
  private async dispatchOne(record: CommandRecord, waitMs: number): Promise<void> {
    if (record.status !== "queued") return;
    if (Date.parse(record.expiresAt)<=Date.now()) { await this.store.markExpiredActiveCommandsUncertain(); return; }
    if (!await this.authorized(record)) {
      await this.store.cancelQueuedCommand(record.commandId,{type:"admin"}); this.onStatusChanged?.(); return;
    }
    let route: SendRoute | undefined;
    try { route = this.targetRoute(record,record.sendRoute); }
    catch (error) { if (error instanceof CommandError) return; throw error; }
    if (!route) return;
    const claimed = await this.store.claimQueuedCommand(record.commandId,route);
    if (!claimed) return;
    if (!await this.authorized(claimed)) { await this.store.updateCommandStatus(claimed.commandId,"failed",undefined,"Dispatch authority revoked before transmission"); return; }
    await this.transmit(claimed,waitMs);
  }
  private async transmit(record: CommandRecord, waitMs: number): Promise<void> {
    const waiter = this.hub.registerCommandResultWaiter(record.commandId,waitMs);
    try {
      const delivery = await this.hub.sendCommand({type:"command",commandId:record.commandId,nodeId:record.nodeId,sessionId:record.sessionId,
        action:record.action,prompt:record.prompt,expiresAt:record.expiresAt,skills:record.skills,...(record.sendRoute ? {sendRoute:record.sendRoute}:{}),
        ...(record.deliveryMode ? {deliveryMode:record.deliveryMode}:{}),...(record.expectedTurnId ? {expectedTurnId:record.expectedTurnId}: {})});
      if (!delivery.delivered) await this.store.updateCommandStatus(record.commandId,"uncertain",undefined,"Transport did not confirm command delivery");
      else if (waitMs>0) await waiter.wait();
    } finally { waiter.cancel(); this.onStatusChanged?.(); }
  }
}
