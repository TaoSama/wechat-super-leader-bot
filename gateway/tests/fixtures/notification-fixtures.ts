import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TestContext } from "node:test";
import { StateManager } from "../../src/runtime/state.js";
import { ILinkClient } from "../../src/wechat/client.js";
import { ControllerClient } from "../../src/controller/client.js";
import { WeChatGateway } from "../../src/gateway.js";
import type { Notification } from "../../src/controller/notification-contract.js";

export const ID = "00000000-0000-4000-8000-000000000001";
export const ATTEMPT = "00000000-0000-4000-8000-000000000002";
export const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status });
export function notification(index = 1, chatId = "chat"): Notification {
  const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  const now = Date.now();
  return { id, source: { type: "plan", id }, chatId, kind: "completed", text: `计划 ${id} 已收到精确完成回执。`,
    createdAt: now - 1000, expiresAt: now + 86400000, status: "pending" };
}
export function goalNotification(kind: "completed" | "blocked" | "expired" = "completed", index = 1): Notification {
  const item = notification(index);
  const text = {
    completed: `持续目标 ${item.id}：模型根据精确完成记录判断条件已满足；这不是独立业务验收。可查询目标进展核对。`,
    blocked: `持续目标 ${item.id}：已停止自动推进，需要处理。请查询目标进展核对当前状态；这不表示原会话任务停止。`,
    expired: `持续目标 ${item.id}：授权已到期，已停止后续派发。请查询目标进展核对当前状态；这不表示原会话任务停止。`,
  };
  return { ...item, source: { type: "goal", id: item.id }, kind, text: text[kind] };
}
export function claimed(item = notification(), attemptId = ATTEMPT): Notification {
  const now = Date.now();
  return { ...item, status: "claimed", attemptId, attemptedAt: now, attemptExpiresAt: Math.min(now + 60000, item.expiresAt) };
}
export function harness(t: TestContext, options: { enabled?: boolean; items?: Notification[]; baseline?: boolean } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-notifications-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const accountPath = path.join(directory, "account.json"), statePath = path.join(directory, "state.json");
  fs.writeFileSync(accountPath, JSON.stringify({ token: "synthetic", accountId: "fixture" }));
  const state = new StateManager(accountPath, statePath);
  if (options.baseline !== false) state.markBaselineEstablished();
  state.setContextToken("chat", "synthetic-context");
  const records = new Map((options.items ?? [notification()]).map(item => [item.id, item]));
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const sends: Record<string, unknown>[] = [];
  const hooks: {
    pending?: (chatIds: string[]) => void | Promise<void>;
    claim?: (item: Notification) => Notification | Promise<Notification>;
    receipt?: (item: Notification) => void;
    send?: () => unknown | Promise<unknown>;
    poll?: () => void;
  } = {};
  const controller = new ControllerClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: "synthetic", fetchImpl: async (url, init) => {
    const pathname = new URL(String(url)).pathname;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requests.push({ url: pathname, body });
    if (pathname.endsWith("/pending")) {
      const chatIds = body.chatIds as string[];
      await hooks.pending?.(chatIds);
      return json({ items: [...records.values()].filter(item => item.status === "pending" && chatIds.includes(item.chatId)).slice(0, 4) });
    }
    const id = pathname.split("/")[3], item = records.get(id);
    if (!item) return json({}, 404);
    if (pathname.endsWith("/claim")) {
      if (item.status !== "pending") return json({}, 409);
      const next = claimed(item, body.attemptId as string);
      records.set(id, next);
      return json({ notification: hooks.claim ? await hooks.claim(next) : next });
    }
    if (pathname.endsWith("/receipt")) {
      const next = { ...item, status: body.status as "accepted" | "uncertain" };
      hooks.receipt?.(next);
      records.set(id, next);
      return json({ notification: next });
    }
    return json({ notification: item });
  } });
  const ilink = new ILinkClient({ stateManager: state, fetchImpl: async (url, init) => {
    if (String(url).endsWith("getupdates")) { hooks.poll?.(); return json({ ret: 0, msgs: [], get_updates_buf: "new-cursor" }); }
    sends.push(JSON.parse(String(init?.body)).msg);
    return json(hooks.send ? await hooks.send() : { ret: 0, errcode: 0 });
  } });
  const gateway = new WeChatGateway({ stateManager: state, controller, ilink, notifications: options.enabled ?? true });
  return { gateway, controller, ilink, state, records, requests, sends, hooks, accountPath, statePath };
}
