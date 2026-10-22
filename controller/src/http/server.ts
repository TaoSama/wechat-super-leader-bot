import { ModelProgressRunner } from "../notifications/model-progress.js";
import express, { Request, Response, NextFunction } from "express";
import http from "http";
import { createMessageTrace, runWithTrace, traceEvent, traceSpan } from "../runtime/telemetry.js";
import fs from "fs";
import { WebSocketServer, WebSocket } from "ws";
import crypto from "crypto";
import { Config } from "../runtime/config.js";
import { IStore, ConflictError } from "../store/interface.js";
import { NodeHub } from "../nodes/hub.js";
import {
  PostCommandRequestSchema,
  PostMessageRequestSchema,
  MAX_DAEMON_RESULT_MESSAGE_BYTES,
} from "../types.js";
import { NaturalLanguageResolver } from "../leader/queries/resolver.js";
import { renderSessionDirectory } from "../leader/queries/session-directory.js";
import { selectExecutionObservation, selectModelObservation } from "../sessions/observation.js";
import { CommandService, CommandError } from "../commands/service.js";
import { publicCommand } from "../commands/public.js";
import { HttpLeaderModel } from "../leader/model/client.js";
import { LeaderModel } from "../leader/model/contracts.js";
import { LeaderOrchestrator } from "../leader/orchestrator.js";
import { ExecutionScheduler } from "../leader/plans/scheduler.js";
import { GoalScheduler } from "../leader/goals/scheduler.js";
import { createGoalDecider } from "../leader/goals/model.js";
import { ConsoleAuthError, ConsoleAuthService } from "../console/auth.js";
import { createConsoleAuthRouter, extractSessionCookie, checkOriginMatches } from "../console/routes.js";
import { isConsoleRead, isConsoleMessage, isSameOriginMessage } from "../console/access.js";
import { createSessionRouter } from "../console/sessions.js";
import { StatusEvents } from "./status-events.js";
import { readConsoleExecutions } from "../console/executions.js";
import { readConsoleGoals } from "../console/goals.js";
import { createNotificationRouter } from "../notifications/routes.js";
import { hashConsoleToken } from "../console/types.js";
import { createMediaRouter } from "../sessions/media-routes.js";
import { createMessageReplyRouter } from "../sessions/message-reply-routes.js";
import { createReadResponseCompression } from "./response-compression.js";
import { createMessageStream } from "./message-stream.js";

import { TaskNotifications } from "../runtime/task-notifications.js";
import { createAutomationRouter } from "../automations/routes.js";
import { createResultArtifactRouter, createResultDeliveryRouter } from "../deliveries/routes.js";
import { createBackgroundRouter, createSourceAutomationRouter } from "../background/routes.js";

function makeMessageRequestId(chatId: string, messageId: string): string {
  // Use sha256 of JSON tuple to guarantee zero collision even if chatId or messageId contains delimiter characters
  const raw = JSON.stringify([chatId, messageId]);
  return "msg_" + crypto.createHash("sha256").update(raw).digest("hex");
}

export class ControllerServer {
  private config: Config;
  private store: IStore;
  private hub: NodeHub;
  private resolver: NaturalLanguageResolver;
  private app: express.Express;
  private server: http.Server;
  private wss: WebSocketServer;
  private commands: CommandService;
  private leader?: LeaderOrchestrator;
  private executions?: ExecutionScheduler;
  private goals?: GoalScheduler;
  private consoleAuth: ConsoleAuthService;
  private now: () => number;
  private statusEvents: StatusEvents<Awaited<ReturnType<ControllerServer["statusSnapshot"]>>>;
  private taskNotifications: TaskNotifications;
  private progress?: ModelProgressRunner;

  // Chat context cache: chatId -> { nodeId, sessionId }
  private chatContexts = new Map<string, { nodeId: string; sessionId: string }>();

  constructor(config: Config, store: IStore, model?: LeaderModel, now: () => number = Date.now) {
    this.config = config;
    this.store = store;
    this.now = now;
    this.hub = new NodeHub(store, config.tokenToNode, () => this.statusEvents?.changed());
    this.commands = new CommandService(store, this.hub, config.commandTtlSeconds, () => this.statusEvents?.changed(),chatId=>config.allowedChatIds.has(chatId),
      (authority, command) => this.taskNotifications.authorizeCommand(authority, command));
    this.consoleAuth = new ConsoleAuthService(store, config.consolePublicUrl, config.controllerToken, now,
      token => this.statusEvents?.revoke(token));
    const leaderModel = model ?? (config.leader ? new HttpLeaderModel(config.leader) : undefined);
    this.taskNotifications = new TaskNotifications(config, store, this.hub, this.commands, leaderModel, now, () => this.statusEvents?.changed());
    if (leaderModel) {
      this.progress = new ModelProgressRunner(store, leaderModel, now, () => this.statusEvents?.changed(), undefined,
        chatId => this.config.allowedChatIds.has(chatId));
      this.executions = new ExecutionScheduler(store, this.commands, { now,
        isChatAllowed: chatId => this.config.allowedChatIds.has(chatId),
        onProgress: (source, createdAt) => this.progress!.request(source, createdAt),
        canDispatch: (execution, index) => {
          const action = execution.plan.actions[index];
          return !!action.sendRoute && this.commands.canDispatchSend(action, action.sendRoute);
        },
        onChanged: () => this.statusEvents?.changed(),
      });
      this.goals = new GoalScheduler(store, this.commands, createGoalDecider(leaderModel), { now,
        isChatAllowed: chatId => this.config.allowedChatIds.has(chatId),
        onProgress: (source, createdAt) => this.progress!.request(source, createdAt),
        canDispatch: (goal, targetIndex) => {
          const target = goal.proposal.targets[targetIndex];
          return !!target && this.commands.canDispatchSend(target, target.sendRoute);
        },
        onChanged: () => this.statusEvents?.changed(),
      });
      this.leader = new LeaderOrchestrator(store, this.hub, this.commands, leaderModel, now,
        requestId => this.consoleAuth.issueLink(requestId), this.executions, this.goals, this.taskNotifications.automations,
        this.taskNotifications.background);
    }
    this.resolver = new NaturalLanguageResolver();
    this.statusEvents = new StatusEvents(() => this.statusSnapshot());

    this.app = express();
    this.server = http.createServer(this.app);
    // WS payload limit: 1MB
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_DAEMON_RESULT_MESSAGE_BYTES });

    this.setupRoutes();
    this.setupWebSocket();
  }

  getHttpServer(): http.Server {
    return this.server;
  }

  getNodeHub(): NodeHub {
    return this.hub;
  }

  private async authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    const authHeader = req.headers.authorization;
    // Browser authorization is limited to explicit workspace operations.
    if (!authHeader && (isConsoleRead(req) || isConsoleMessage(req))) {
      const origin = this.consoleAuth.getPublicUrl();
      const cookie = origin ? extractSessionCookie(req, new URL(origin).protocol === "https:") : null;
      const consoleSession = cookie ? await this.consoleAuth.verifySession(cookie) : null;
      if (cookie && consoleSession) {
        if (req.path === "/events" && !checkOriginMatches(req, origin)) {
          res.status(403).json({ error: "Status stream requires a same-origin request" });
          return;
        }
        res.locals.consoleSessionToken = cookie;
        res.locals.commandAuthority = {type:"console",tokenHash:hashConsoleToken(cookie),expiresAt:consoleSession.expiresAt};
        res.locals.verifyStatusAuth = async () => Boolean(await this.consoleAuth.verifySession(cookie));
        if (isConsoleMessage(req)) {
          if (!isSameOriginMessage(req, origin)) {
            res.status(403).json({ code: "CONSOLE_ORIGIN_REJECTED", error: "Session messages require a same-origin request" });
            return;
          }
          res.locals.assertConsoleDispatch = async () => {
            if (!await this.consoleAuth.verifySession(cookie)) {
              throw new ConsoleAuthError("Console session expired before dispatch", 401);
            }
          };
        }
        next();
        return;
      }
    }
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({
        code: "MISSING_AUTH_HEADER",
        error: "Missing or invalid Authorization header",
      });
      return;
    }

    const token = authHeader.slice("Bearer ".length).trim();
    if (token !== this.config.controllerToken) {
      res.status(403).json({
        code: "INVALID_CONTROLLER_TOKEN",
        error: "Invalid controller token",
      });
      return;
    }

    res.locals.verifyStatusAuth = async () => token === this.config.controllerToken;
    next();
  }

  private async statusSnapshot() {
    await this.store.markExpiredActiveCommandsUncertain();
    const nodes = this.hub.getNodeStatusList();
    const sessions = await this.hub.getAllSessions();
    const commands = await this.store.listRecentCommandSummaries(50);
    const executions = await readConsoleExecutions(this.store, [...this.config.allowedChatIds], this.now(), true);
    const goals = await readConsoleGoals(this.store, [...this.config.allowedChatIds], this.now(), true);
    return { nodes, sessions, commands, executions, goals, ...await this.taskNotifications.snapshot(), skills: this.hub.getAllSkills(),
      leaderMode: this.leader ? "model" : "rules", leaderModel: this.config.leader?.model };
  }

  private setupRoutes(): void {
    this.app.use((_req: Request, res: Response, next: NextFunction) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      next();
    });
    this.app.use(createReadResponseCompression());
    this.app.use(express.json({ limit: "1mb" }));
    this.app.use("/auth", createConsoleAuthRouter(this.consoleAuth));
    this.app.use("/v1/result-artifacts", createResultArtifactRouter(this.taskNotifications.results, () => this.config.allowedChatIds, this.now));
    if (this.taskNotifications.backgroundArtifacts) {
      this.app.use("/v1/background-artifacts", this.taskNotifications.backgroundArtifacts.router());
    }

    // Public liveness endpoint
    this.app.get("/health", (req: Request, res: Response) => {
      res.json({
        status: "ok",
        timestamp: new Date().toISOString(),
      });
    });

    // Authenticated API router for /v1
    const apiRouter = express.Router();
    apiRouter.use(this.authMiddleware.bind(this));
    apiRouter.use(createMediaRouter(this.store, () => this.config.allowedChatIds, this.now));
    apiRouter.use(createMessageReplyRouter(this.store, () => this.config.allowedChatIds));
    apiRouter.use("/notifications", createNotificationRouter(this.store, () => this.config.allowedChatIds, this.now));
    apiRouter.use("/deliveries", createResultDeliveryRouter(this.taskNotifications.results, () => this.config.allowedChatIds));
    apiRouter.use("/background-tasks", createBackgroundRouter(this.taskNotifications.background, () => this.config.allowedChatIds));
    apiRouter.use("/source-automations", createSourceAutomationRouter(this.hub));
    apiRouter.use("/automations", createAutomationRouter(this.taskNotifications.automations, {
      allowed: () => this.config.allowedChatIds, now: this.now,
      authority: async (req, chatId) => ({ chatId, currentMessageId: String(req.headers["idempotency-key"] || crypto.randomUUID()), explicitCurrentTurnAuthorization: true }),
    }));
    apiRouter.use("/sessions", createSessionRouter(this.hub, this.commands));
    apiRouter.get("/chats/notification-interest", async (_req: Request, res: Response) => {
      res.json({ chatIds: [...this.config.allowedChatIds], interested: await this.taskNotifications.notificationInterest() });
    });
    apiRouter.post("/chats/authorize", (req: Request,res: Response) => {
      if (!req.is("application/json") || !req.body || Object.keys(req.body).length !== 1 || typeof req.body.chatId !== "string") {
        res.status(400).json({error:"Invalid chat authorization request"}); return;
      }
      if (!this.config.allowedChatIds.has(req.body.chatId)) {res.status(403).json({code:"CHAT_NOT_ALLOWED"});return;}
      res.json({allowed:true});
    });
    apiRouter.post("/commands/:commandId/cancel",async(req: Request,res: Response)=>{
      res.json(publicCommand(await this.commands.cancel(String(req.params.commandId),{type:"admin"})));
    });

    apiRouter.post("/console-links", async (req: Request, res: Response) => {
      const body = req.body;
      if (!req.is("application/json") || !body || typeof body !== "object" || Array.isArray(body) ||
          Object.keys(body).length !== 1 || !Object.hasOwn(body, "requestId") ||
          typeof body.requestId !== "string" || !body.requestId.trim() || body.requestId.length > 256) {
        res.status(400).json({ error: "Invalid console link request" });
        return;
      }
      res.json(await this.consoleAuth.issueLink(body.requestId));
    });

    // GET /v1/status and /v1/events share the complete read-only workspace snapshot.
    apiRouter.get("/status", async (req: Request, res: Response) => {
      res.json(await this.statusEvents.readSnapshot());
    });
    apiRouter.get("/events", (req: Request, res: Response) => {
      if (req.originalUrl !== "/v1/events") {
        res.status(400).json({ error: "Status stream does not accept query parameters or alternate paths" });
        return;
      }
      this.statusEvents.open(res, res.locals.verifyStatusAuth, res.locals.consoleSessionToken);
    });
    apiRouter.get("/skills", (_req: Request, res: Response) => { res.json({ skills: this.hub.getAllSkills() }); });

    // POST /v1/commands -> { commandId, status }
    apiRouter.post("/commands", async (req: Request, res: Response) => {
      const parsed = PostCommandRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid command request body", details: parsed.error.format() });
        return;
      }

      try {
        const command = await this.commands.submit(parsed.data, parsed.data.action === "read" ? 5000 : 0);
        res.status(["admitting","queued","pending"].includes(command.status) ? 202 : 200).json(publicCommand(command));
      } catch (error) {
        if (error instanceof CommandError || error instanceof ConflictError) {
          res.status(error instanceof ConflictError ? 409 : error.httpStatus).json({ error: error.message });
          return;
        }
        throw error;
      }
    });

    // GET /v1/commands/:id -> command record
    apiRouter.get("/commands/:id", async (req: Request, res: Response) => {
      await this.store.markExpiredActiveCommandsUncertain();
      const commandId = req.params.id as string;
      const cmd = await this.store.getCommand(commandId);
      if (!cmd) {
        res.status(404).json({ error: "Command not found" });
        return;
      }
      res.json(publicCommand(cmd));
    });

    // POST /v1/messages -> { text, commandId? }
    apiRouter.post("/messages", async (req: Request, res: Response) => {
      const parsed = PostMessageRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid message request body", details: parsed.error.format() });
        return;
      }

      const { chatId, messageId, text } = parsed.data;

      // ALLOWED_CHAT_IDS exact allowlist required. Reject unconditionally with CHAT_NOT_ALLOWED code.
      if (!this.config.allowedChatIds.has(chatId)) {
        res.status(403).json({
          code: "CHAT_NOT_ALLOWED",
          error: `Chat ID '${chatId}' is not authorized in ALLOWED_CHAT_IDS`,
        });
        return;
      }

      const stream = createMessageStream(req, res);
      if (res.writableEnded) return;
      const reply = async (value: unknown) => {
        if (stream) await stream.reply(value);
        else res.json(value);
      };

      const trace = createMessageTrace(chatId, messageId, undefined, req.headers["x-latency-attempt"] as string | undefined);
      await runWithTrace(trace, async () => {
        traceEvent("controller.received", { inputChars: text.length });
        let finished = false;
        res.once("finish", () => runWithTrace(trace, () => {
          finished = true;
          traceEvent("controller.response.finish", { httpStatus: res.statusCode,
            outcome: res.statusCode < 400 ? "ok" : "error" });
        }));
        res.once("close", () => {
          if (!finished) runWithTrace(trace, () => traceEvent("controller.response.close", {
            httpStatus: res.statusCode, outcome: "disconnected",
          }));
        });
        await traceSpan("controller.message", async () => {
          // Deduplication: Persist message dedupe
          const existingMsg = await traceSpan("controller.dedupe", () => this.store.getMessage(chatId, messageId));
          if (existingMsg) {
            if (existingMsg.text !== text) throw new ConflictError("Message ID already used with different text");
            traceEvent("controller.replay", { replayed: true });
            await reply({
              text: existingMsg.replyText,
              commandId: existingMsg.commandId,
              ...(existingMsg.images ? { images: existingMsg.images } : {}),
            });
            return;
          }

          if (this.leader) {
            const result = await traceSpan("controller.leader", () => this.leader!.handle(chatId, messageId, text, stream?.report));
            await traceSpan("controller.persist", () => this.store.recordMessage({ chatId, messageId, text, replyText: result.text,
              commandId: result.commandId, ...(result.images ? { images: result.images } : {}), createdAt: new Date().toISOString() }));
            await reply(result);
            return;
          }

          // Resolve intent
          const sessions = await traceSpan("controller.sessions", () => this.hub.getAllSessions());
          const lastCtx = this.chatContexts.get(chatId);
          const intent = this.resolver.resolve(text, { sessions, lastContext: lastCtx });

          let replyText = "";
          let commandId: string | undefined = undefined;

          if (intent.action === "list_nodes") {
            const nodes = this.hub.getNodeStatusList();
            if (nodes.length === 0) {
              replyText = "当前没有在线节点连接。";
            } else {
              const lines = nodes.map(
                (n) => `- **${n.nodeId}**: ${n.connected ? "在线 (🟢)" : "离线 (🔴)"} | 会话数: ${n.sessionCount} | 最近心跳: ${n.lastHeartbeat}`
              );
              replyText = `### 节点列表\n\n${lines.join("\n")}`;
            }
          } else if (intent.action === "list_sessions") {
            const capturedAt = this.now();
            replyText = renderSessionDirectory(sessions.map(session => ({ ...session,
              ...selectExecutionObservation(session, capturedAt),
              modelView: selectModelObservation(session, capturedAt),
            })));
          } else if (intent.action === "clarification") {
            replyText = intent.clarificationMessage || "请进一步明确指定目标会话。";
          } else if (intent.action === "unknown") {
            replyText = intent.replyText || "未能识别该指令意图。可以尝试“查看会话列表”或“查看进度”。";
          } else if (intent.action === "read_session" || intent.action === "send_session") {
            const action = intent.action === "read_session" ? "read" : "send";
            try {
              const command = await this.commands.submit({
                nodeId: intent.nodeId!, sessionId: intent.sessionId!, action,
                prompt: action === "send" ? intent.prompt : undefined,
                requestId: makeMessageRequestId(chatId, messageId),
              }, action === "read" ? 5000 : 4000,undefined,undefined,{type:"chat",chatId});
              commandId = command.commandId;
              this.chatContexts.set(chatId, { nodeId: intent.nodeId!, sessionId: intent.sessionId! });
              replyText = action === "read" && command.status === "completed"
                ? `会话 [${command.nodeId}] ${command.sessionId} 最新输出：\n${command.output || "(无输出内容)"}`
                : `命令 ${commandId}：${command.status}。accepted 仅表示输入受理；pending/uncertain 请先核查状态，勿重复派发。`;
            } catch (error) {
              if (!(error instanceof CommandError || error instanceof ConflictError)) throw error;
              replyText = `无法处理该请求：${error.message}`;
            }
          }

          // Persist processed message record
          await traceSpan("controller.persist", () => this.store.recordMessage({
            chatId,
            messageId,
            text,
            replyText,
            commandId,
            createdAt: new Date().toISOString(),
          }));

          await reply({
            text: replyText,
            commandId,
          });
        });
      });
    });

    this.app.use("/v1", apiRouter);
    this.app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (res.headersSent) {
        if (!res.destroyed && !res.writableEnded) {
          if (String(res.getHeader("Content-Type")).startsWith("application/x-ndjson")) {
            res.end(JSON.stringify({ type: "error", code: "REPLY_UNAVAILABLE" }) + "\n");
          } else res.destroy();
        }
        return;
      }
      if (error instanceof ConsoleAuthError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      if (error instanceof CommandError || error instanceof ConflictError) {
        res.status(error instanceof ConflictError ? 409 : error.httpStatus).json({ error: error.message });
        return;
      }
      const badBody = typeof error === "object" && error !== null && "status" in error && error.status === 400;
      console.error("Controller request failed:", badBody ? "InvalidJsonBody" : "OperationalError");
      res.status(badBody ? 400 : 503).json({ error: badBody ? "Invalid JSON body" : "Controller temporarily unavailable; no automatic command replay" });
    });

    // Optional Static Web Dist serving (Express 5 compatible fallback)
    if (this.config.webDistDir && fs.existsSync(this.config.webDistDir)) {
      this.app.use(express.static(this.config.webDistDir, { cacheControl: false }));
      this.app.get("/{*path}", (req: Request, res: Response, next: NextFunction) => {
        if (req.path.startsWith("/v1") || req.path.startsWith("/auth") || req.path === "/health") {
          return next();
        }
        res.sendFile("index.html", { root: this.config.webDistDir, cacheControl: false });
      });
    }
  }

  private setupWebSocket(): void {
    this.server.on("upgrade", (request, socket, head) => {
      let url: URL;
      try {
        url = new URL(request.url || "", "http://localhost");
      } catch {
        // Upgrade events run outside Express's request error middleware.
        socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n", () => socket.destroy());
        return;
      }
      if (url.pathname !== "/v1/daemon") {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }

      // Authenticate via Authorization Bearer <node token>
      const authHeader = request.headers["authorization"] || "";
      if (!authHeader.startsWith("Bearer ")) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      const token = authHeader.slice("Bearer ".length).trim();
      const nodeId = this.hub.authenticateToken(token);
      if (!nodeId) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.hub.handleConnection(ws as WebSocket, nodeId);
      });
    });
  }

  async start(): Promise<void> {
    await this.store.init();
    await this.taskNotifications.initialize();
    await new Promise<void>((resolve) => {
      this.server.listen(this.config.port, this.config.host, () => {
        console.log(`Controller server listening on ${this.config.host}:${this.config.port}`);
        resolve();
      });
    });
    this.executions?.start();
    this.goals?.start();
    this.progress?.start();
    this.commands.start();
    this.taskNotifications.start();
  }

  async stop(): Promise<void> {
    await Promise.all([this.taskNotifications.stop(), this.executions?.stop(), this.goals?.stop(),this.progress?.stop(),this.commands.stop()]);
    this.statusEvents.stop();
    // Proactively close all active node websocket connections first
    await this.hub.closeAll();
    await new Promise<void>((resolve) => {
      this.wss.close(() => {
        this.server.close(() => resolve());
      });
    });
    await this.store.close();
  }
}
