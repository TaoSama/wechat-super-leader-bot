import { Router, type Response } from "express";
import { z } from "zod";
import type { LocalSettingsService } from "./local-service.js";
import { GatewaySettingsClient, SettingsHttpError } from "./gateway-client.js";

const Scope = z.enum(["wechat", "controller", "background"]);
const ChatId = z.string().min(1).max(4096);
const Query = z.object({ chatId: ChatId.optional() }).strict();
const ResourceId = z.string().regex(/^(?:gateway|controller)\.[a-zA-Z\d._-]{1,255}$/);
const ModelMutation = z.object({ scope: Scope, model: z.string().trim().min(1).max(256),
  reasoningEffort: z.string().trim().min(1).max(32).nullable(), expectedRevision: z.string().min(1).max(256) }).strict();
const DocumentMutation = z.object({ chatId: ChatId.optional(), content: z.string().max(512 * 1024),
  expectedRevision: z.string().min(1).max(256) }).strict();
const SNAPSHOT_TIMEOUT_MS = 3_000;

export type SettingsDiagnostic = {id: string; label: string; value: string; status: "ok" | "warning" | "error"};
type Options = { local: LocalSettingsService; gateway: GatewaySettingsClient;
  allowedChats: () => ReadonlySet<string>; diagnostics?: () => SettingsDiagnostic[] };

export function createSettingsRouter(options: Options): Router {
  const router = Router();
  const unavailable = (): SettingsDiagnostic => ({ id: "gateway-settings", label: "微信助手设置", value: "连接不可用", status: "error" });
  const permit = (chatId: string | undefined, res: Response): boolean => {
    if (chatId === undefined || options.allowedChats().has(chatId)) return true;
    res.status(403).json({ error: "聊天不在当前授权范围内", code: "CHAT_NOT_ALLOWED" }); return false;
  };
  router.get("/", async (_req, res) => {
    const startedAt = performance.now();
    const local = await options.local.snapshot();
    let gateway: Record<string, unknown> = { scopes: [], chats: [], diagnostics: [] };
    try { gateway = await options.gateway.request("/settings", "GET", undefined, SNAPSHOT_TIMEOUT_MS); }
    catch (error) { if (!(error instanceof SettingsHttpError)) throw error; gateway.diagnostics = [unavailable()]; }
    if (!Array.isArray(gateway.scopes) || !Array.isArray(gateway.chats) || !Array.isArray(gateway.diagnostics)) {
      gateway = { scopes: [], chats: [], diagnostics: [unavailable()] };
    }
    const scopes = gateway.scopes as unknown[], chats = gateway.chats as unknown[], diagnostics = gateway.diagnostics as unknown[];
    res.json({ scopes: [...scopes, ...local.scopes],
      chats: chats.filter(chat => chat && typeof chat === "object" && "chatId" in chat &&
        typeof chat.chatId === "string" && options.allowedChats().has(chat.chatId)),
      diagnostics: [...local.diagnostics, ...(options.diagnostics?.() ?? []), ...diagnostics,
        {id:"settings-request-latency",label:"本次设置读取耗时",value:`${Math.round(performance.now()-startedAt)} ms`,status:"ok"}] });
  });
  router.get("/models", async (req, res) => {
    const query = z.object({ scope: Scope }).strict().safeParse(req.query);
    if (!query.success) { res.status(400).json({ error: "请选择模型作用范围" }); return; }
    res.json(query.data.scope === "wechat" ? await options.gateway.request("/settings/models?scope=wechat")
      : await options.local.models(query.data.scope));
  });
  router.post("/models/refresh", async (req, res) => {
    const body = z.object({ scope: Scope }).strict().safeParse(req.body);
    if (!req.is("application/json") || !body.success) { res.status(400).json({ error: "刷新模型请求无效" }); return; }
    await res.locals.assertConsoleDispatch?.();
    res.json(body.data.scope === "wechat" ? await options.gateway.request("/settings/models/refresh", "POST", body.data)
      : await options.local.models(body.data.scope, true));
  });
  router.post("/models", async (req, res) => {
    const body = ModelMutation.safeParse(req.body);
    if (!req.is("application/json") || !body.success) { res.status(400).json({ error: "模型设置无效" }); return; }
    await res.locals.assertConsoleDispatch?.();
    res.json(body.data.scope === "wechat" ? await options.gateway.request("/settings/models", "POST", body.data)
      : await options.local.updateModel({ ...body.data, scope: body.data.scope }));
  });
  router.get("/resources", async (req, res) => {
    const query = Query.safeParse(req.query);
    if (!query.success) { res.status(400).json({ error: "资源查询无效" }); return; }
    if (!permit(query.data.chatId, res)) return;
    const resources = options.local.listResources();
    try {
      const search = new URLSearchParams(query.data.chatId ? { chatId: query.data.chatId } : {});
      const remote = await options.gateway.request(`/settings/resources?${search}`, "GET", undefined, SNAPSHOT_TIMEOUT_MS);
      if (!Array.isArray(remote.resources)) throw new SettingsHttpError(503, "微信助手资源目录无效");
      res.json({ resources: [...resources, ...remote.resources] });
    } catch (error) {
      if (!(error instanceof SettingsHttpError)) throw error;
      // Instance resources remain usable when the separate Gateway process is offline.
      if (error.statusCode !== 503) throw error;
      res.json({ resources, diagnostics: [unavailable()] });
    }
  });
  router.get("/resources/:id", async (req, res) => {
    const query = Query.safeParse(req.query), id = ResourceId.safeParse(req.params.id);
    if (!query.success || !id.success) { res.status(400).json({ error: "资源查询无效" }); return; }
    if (!permit(query.data.chatId, res)) return;
    const search = new URLSearchParams(query.data.chatId ? { chatId: query.data.chatId } : {});
    res.json(id.data.startsWith("controller.") ? options.local.readResource(id.data)
      : await options.gateway.request(`/settings/resources/${encodeURIComponent(id.data)}?${search}`));
  });
  router.post("/resources/:id", async (req, res) => {
    const body = DocumentMutation.safeParse(req.body), id = ResourceId.safeParse(req.params.id);
    if (!req.is("application/json") || !body.success || !id.success) { res.status(400).json({ error: "资源保存请求无效" }); return; }
    if (!permit(body.data.chatId, res)) return;
    await res.locals.assertConsoleDispatch?.();
    res.json(id.data.startsWith("controller.") ? options.local.updateResource(id.data, body.data.content, body.data.expectedRevision)
      : await options.gateway.request(`/settings/resources/${encodeURIComponent(id.data)}`, "POST", body.data));
  });
  router.use((error: unknown, _req: unknown, res: Response, _next: unknown) => {
    if (error && typeof error === "object" && "statusCode" in error &&
        typeof error.statusCode === "number" && [400,401,403,404,409,503].includes(error.statusCode)) {
      res.status(error.statusCode).json({ error: error instanceof Error ? error.message : "设置操作失败",
        ...("code" in error && typeof error.code === "string" ? { code: error.code } : {}) }); return;
    }
    console.error("Settings request failed: OperationalError");
    res.status(503).json({ error: "设置服务暂不可用", code: "SETTINGS_UNAVAILABLE" });
  });
  return router;
}
