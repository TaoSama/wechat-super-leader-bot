import { describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { AutomationService } from "../../src/automations/service.js";
import { ControllerServer } from "../../src/http/server.js";
import { MemoryStore } from "../../src/store/memory.js";

const ADMIN_TOKEN = "synthetic-prompt-admin-token";
const ORIGIN = "https://console.example.test";
const SCHEDULE_ID = "11111111-1111-4111-8111-111111111111";

describe("console access to background prompt edits", () => {
  it("keeps prompt edits Bearer-only even with a valid same-origin console cookie and status intent", async () => {
    const update = vi.spyOn(AutomationService.prototype, "updatePrompt").mockResolvedValue(null);
    const server = new ControllerServer({ port: 0, host: "127.0.0.1", controllerToken: ADMIN_TOKEN,
      nodeTokens: {}, tokenToNode: new Map(), allowedChatIds: new Set(["chat"]), persistenceMode: "memory",
      commandTtlSeconds: 60, consolePublicUrl: ORIGIN }, new MemoryStore());
    try {
      await server.start();
      const base = `http://127.0.0.1:${(server.getHttpServer().address() as AddressInfo).port}`;
      const issued = await fetch(`${base}/v1/console-links`, { method: "POST", headers: {
        "content-type": "application/json", authorization: `Bearer ${ADMIN_TOKEN}` }, body: JSON.stringify({ requestId: "prompt-login" }) });
      expect(issued.status).toBe(200);
      const { url } = await issued.json();
      const exchange = await fetch(`${base}/auth/exchange`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ token: url.split("#login=")[1] }) });
      expect(exchange.status).toBe(200);
      const cookie = exchange.headers.get("set-cookie")?.split(";")[0];
      expect(cookie).toBeTruthy();
      const promptUrl = `${base}/v1/automations/${SCHEDULE_ID}/prompt`;
      const body = JSON.stringify({ chatId: "chat", prompt: "updated report", expectedPromptRevision: 0 });
      const browserHeaders = { "content-type": "application/json", cookie: cookie!, origin: ORIGIN,
        "x-super-leader-intent": "automation-status", "sec-fetch-site": "same-origin", "idempotency-key": "browser-edit" };
      for (const headers of [{ "content-type": "application/json" }, browserHeaders, { ...browserHeaders, "x-super-leader-intent": "automation-prompt" }]) {
        expect((await fetch(promptUrl, { method: "POST", headers, body })).status).toBe(401);
      }
      expect((await fetch(promptUrl, { method: "POST", headers: { ...browserHeaders, authorization: "Bearer wrong-token" }, body })).status).toBe(403);
      expect(update).not.toHaveBeenCalled();

      const status = await fetch(`${base}/v1/automations/${SCHEDULE_ID}/status`, { method: "POST", headers: browserHeaders,
        body: JSON.stringify({ chatId: "chat", status: "paused" }) });
      expect(status.status).toBe(404);
      const admin = await fetch(promptUrl, { method: "POST", headers: { "content-type": "application/json",
        authorization: `Bearer ${ADMIN_TOKEN}`, "idempotency-key": "trusted-admin-edit" }, body });
      expect(admin.status).toBe(404);
      expect(update).toHaveBeenCalledExactlyOnceWith(SCHEDULE_ID, { prompt: "updated report", expectedPromptRevision: 0 }, {
        chatId: "chat", currentMessageId: "trusted-admin-edit", explicitCurrentTurnAuthorization: true,
        source: "admin_api", idempotencyKey: "trusted-admin-edit",
      }, expect.any(Number));
    } finally {
      await server.stop();
      vi.restoreAllMocks();
    }
  });
});
