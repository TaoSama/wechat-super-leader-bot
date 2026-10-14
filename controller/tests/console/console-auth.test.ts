import { describe, it, expect, vi } from "vitest";
import { WebSocket } from "ws";
import type { AddressInfo } from "net";
import { ControllerServer } from "../../src/http/server.js";
import { MemoryStore } from "../../src/store/memory.js";
import { Config } from "../../src/runtime/config.js";
import { ConsoleAuthService } from "../../src/console/auth.js";

interface TestContext {
  server: ControllerServer;
  store: MemoryStore;
  baseUrl: string;
  wsUrl: string;
  controllerToken: string;
  nodeToken: string;
  consoleOrigin: string;
  stop: () => Promise<void>;
}

async function createServerFixture(options: {
  consolePublicUrl?: string;
  clock?: () => number;
}): Promise<TestContext> {
  const controllerToken = "ctrl-token-sec-9999";
  const nodeToken = "node-token-demoair-8888";
  const consoleOrigin = options.consolePublicUrl ?? "http://127.0.0.1:8790";

  const config: Config = {
    port: 0,
    host: "127.0.0.1",
    controllerToken,
    nodeTokens: Object.assign(Object.create(null), { demoair: nodeToken }),
    tokenToNode: new Map([[nodeToken, "demoair"]]),
    allowedChatIds: new Set(["chat-1"]),
    persistenceMode: "memory",
    commandTtlSeconds: 60,
    consolePublicUrl: consoleOrigin,
  };

  const store = new MemoryStore();
  const server = new ControllerServer(config, store, undefined, options.clock);
  await server.start();

  const addr = server.getHttpServer().address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  const wsUrl = `ws://127.0.0.1:${addr.port}`;

  return {
    server,
    store,
    baseUrl,
    wsUrl,
    controllerToken,
    nodeToken,
    consoleOrigin,
    stop: async () => {
      await server.stop();
    },
  };
}

describe("Console Auth HTTP API & Security", () => {
  it("ConsoleAuthService can be injected with custom now clock", async () => {
    const store = new MemoryStore();
    let virtualClock = 1700000000000;
    const authService = new ConsoleAuthService(
      store,
      "http://127.0.0.1:8790",
      "ctrl-token-123",
      () => virtualClock
    );

    const link = await authService.issueLink("req-custom-clock");
    expect(new Date(link.expiresAt).getTime()).toBe(virtualClock + 3600 * 1000);

    // Advance clock past expiration
    virtualClock += 3601 * 1000;
    const exchanged = await authService.exchangeToken(
      link.url.slice(link.url.indexOf("=") + 1)
    );
    expect(exchanged).toBeNull();
  });

  it("POST /v1/console-links issues 1h link with 43-char token, same requestId is idempotent without extending expiry, used gives 409, expired gives 410", async () => {
    let now = 1700000000000;
    const ctx = await createServerFixture({
      consolePublicUrl: "https://leader.example.com",
      clock: () => now,
    });

    try {
      // 1. Issue link
      const res1 = await fetch(`${ctx.baseUrl}/v1/console-links`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ctx.controllerToken}`,
        },
        body: JSON.stringify({ requestId: "req-1" }),
      });
      expect(res1.status).toBe(200);
      const data1 = await res1.json();
      expect(new URL(data1.url).origin).toBe("https://leader.example.com");
      expect(new URL(data1.url).hash).toMatch(/^#login=[A-Za-z0-9_-]{43}$/);
      const rawToken1 = data1.url.slice(data1.url.indexOf("=") + 1);
      expect(rawToken1).toHaveLength(43);
      expect(new Date(data1.expiresAt).getTime()).toBe(now + 3600 * 1000);

      // 2. Same requestId produces same URL and exact same expiresAt (no extension)
      now += 600 * 1000; // 10 minutes later
      const res2 = await fetch(`${ctx.baseUrl}/v1/console-links`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ctx.controllerToken}`,
        },
        body: JSON.stringify({ requestId: "req-1" }),
      });
      expect(res2.status).toBe(200);
      const data2 = await res2.json();
      expect(data2.url).toBe(data1.url);
      expect(data2.expiresAt).toBe(data1.expiresAt);

      // 3. Consume token, then requesting link again returns 409
      const exRes = await fetch(`${ctx.baseUrl}/auth/exchange`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://leader.example.com",
        },
        body: JSON.stringify({ token: rawToken1 }),
      });
      expect(exRes.status).toBe(200);

      const resConsumed = await fetch(`${ctx.baseUrl}/v1/console-links`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ctx.controllerToken}`,
        },
        body: JSON.stringify({ requestId: "req-1" }),
      });
      expect(resConsumed.status).toBe(409);
      const errConsumed = await resConsumed.json();
      expect(errConsumed.error).toMatch(/consumed/i);

      // 4. Request for expired link returns 410
      const resExpInitial = await fetch(`${ctx.baseUrl}/v1/console-links`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ctx.controllerToken}`,
        },
        body: JSON.stringify({ requestId: "req-exp" }),
      });
      expect(resExpInitial.status).toBe(200);

      now += 3601 * 1000; // advance past expiry
      const resExp = await fetch(`${ctx.baseUrl}/v1/console-links`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ctx.controllerToken}`,
        },
        body: JSON.stringify({ requestId: "req-exp" }),
      });
      expect(resExp.status).toBe(410);
      const errExp = await resExp.json();
      expect(errExp.error).toMatch(/expired/i);
    } finally {
      await ctx.stop();
    }
  });

  it("POST /auth/exchange enforces strict JSON with token only, rejecting invalid/replay/expired with 401", async () => {
    let now = 1700000000000;
    const ctx = await createServerFixture({
      consolePublicUrl: "https://leader.example.com",
      clock: () => now,
    });

    try {
      // Issue a valid link
      const issueRes = await fetch(`${ctx.baseUrl}/v1/console-links`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ctx.controllerToken}`,
        },
        body: JSON.stringify({ requestId: "req-strict-json" }),
      });
      const { url } = await issueRes.json();
      const validToken = url.slice(url.indexOf("=") + 1);

      // Rejects extra JSON fields (strict token only)
      const resExtra = await fetch(`${ctx.baseUrl}/auth/exchange`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://leader.example.com",
        },
        body: JSON.stringify({ token: validToken, extra: "malicious" }),
      });
      expect(resExtra.status).toBe(401);

      // Rejects non-JSON or invalid bodies
      const resBadBody = await fetch(`${ctx.baseUrl}/auth/exchange`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://leader.example.com",
        },
        body: JSON.stringify({}),
      });
      expect(resBadBody.status).toBe(401);

      // Rejects invalid token formats
      const resInvalidToken = await fetch(`${ctx.baseUrl}/auth/exchange`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://leader.example.com",
        },
        body: JSON.stringify({ token: "invalid-token-short" }),
      });
      expect(resInvalidToken.status).toBe(401);

      // Valid exchange succeeds
      const resOk = await fetch(`${ctx.baseUrl}/auth/exchange`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://leader.example.com",
        },
        body: JSON.stringify({ token: validToken }),
      });
      expect(resOk.status).toBe(200);
      const okData = await resOk.json();
      expect(okData.authenticated).toBe(true);

      // Replay attempt fails with 401
      const resReplay = await fetch(`${ctx.baseUrl}/auth/exchange`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://leader.example.com",
        },
        body: JSON.stringify({ token: validToken }),
      });
      expect(resReplay.status).toBe(401);
    } finally {
      await ctx.stop();
    }
  });

  it("sets __Host-super_leader_session cookie on HTTPS origin with Secure, HttpOnly, SameSite=Strict, Path=/, Max-Age=3600", async () => {
    const ctx = await createServerFixture({
      consolePublicUrl: "https://leader.example.com",
    });

    try {
      const issueRes = await fetch(`${ctx.baseUrl}/v1/console-links`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ctx.controllerToken}`,
        },
        body: JSON.stringify({ requestId: "req-cookie-https" }),
      });
      const { url } = await issueRes.json();
      const token = url.slice(url.indexOf("=") + 1);

      const res = await fetch(`${ctx.baseUrl}/auth/exchange`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://leader.example.com",
        },
        body: JSON.stringify({ token }),
      });
      expect(res.status).toBe(200);

      const setCookies = res.headers.getSetCookie();
      expect(setCookies.length).toBeGreaterThan(0);
      const cookieStr = setCookies[0];

      expect(cookieStr).toContain("__Host-super_leader_session=");
      expect(cookieStr).toContain("Path=/");
      expect(cookieStr).toContain("HttpOnly");
      expect(cookieStr).toContain("Secure");
      expect(cookieStr.toLowerCase()).toContain("samesite=strict");
      expect(cookieStr).toContain("Max-Age=3600");
    } finally {
      await ctx.stop();
    }
  });

  it("sets super_leader_session on loopback HTTP and strictly ignores the other cookie name in each environment", async () => {
    // 1. Loopback HTTP environment
    const httpCtx = await createServerFixture({
      consolePublicUrl: "http://127.0.0.1:8790",
    });

    try {
      const issueRes = await fetch(`${httpCtx.baseUrl}/v1/console-links`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${httpCtx.controllerToken}`,
        },
        body: JSON.stringify({ requestId: "req-cookie-http" }),
      });
      const { url } = await issueRes.json();
      const token = url.slice(url.indexOf("=") + 1);

      const res = await fetch(`${httpCtx.baseUrl}/auth/exchange`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://127.0.0.1:8790",
        },
        body: JSON.stringify({ token }),
      });
      expect(res.status).toBe(200);

      const setCookies = res.headers.getSetCookie();
      expect(setCookies[0]).toContain("super_leader_session=");
      expect(setCookies[0]).not.toContain("__Host-super_leader_session=");
      expect(setCookies[0]).not.toContain("Secure"); // HTTP cannot use Secure

      const sessionToken = setCookies[0].split(";")[0].split("=")[1];

      // Request /auth/session using the wrong cookie name __Host-super_leader_session -> 401
      const resWrongCookie = await fetch(`${httpCtx.baseUrl}/auth/session`, {
        headers: {
          Cookie: `__Host-super_leader_session=${sessionToken}`,
        },
      });
      expect(resWrongCookie.status).toBe(401);

      // Request /auth/session using correct cookie name -> 200
      const resRightCookie = await fetch(`${httpCtx.baseUrl}/auth/session`, {
        headers: {
          Cookie: `super_leader_session=${sessionToken}`,
        },
      });
      expect(resRightCookie.status).toBe(200);
    } finally {
      await httpCtx.stop();
    }

    // 2. HTTPS environment: ignores super_leader_session
    const httpsCtx = await createServerFixture({
      consolePublicUrl: "https://leader.example.com",
    });

    try {
      const issueRes = await fetch(`${httpsCtx.baseUrl}/v1/console-links`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${httpsCtx.controllerToken}`,
        },
        body: JSON.stringify({ requestId: "req-cookie-https-verify" }),
      });
      const { url } = await issueRes.json();
      const token = url.slice(url.indexOf("=") + 1);

      const exRes = await fetch(`${httpsCtx.baseUrl}/auth/exchange`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://leader.example.com",
        },
        body: JSON.stringify({ token }),
      });
      const setCookies = exRes.headers.getSetCookie();
      const sessionToken = setCookies[0].split(";")[0].split("=")[1];

      // Send insecure-named cookie to HTTPS controller -> 401
      const resInsecureName = await fetch(`${httpsCtx.baseUrl}/auth/session`, {
        headers: {
          Cookie: `super_leader_session=${sessionToken}`,
        },
      });
      expect(resInsecureName.status).toBe(401);

      // Send __Host- cookie -> 200
      const resSecureName = await fetch(`${httpsCtx.baseUrl}/auth/session`, {
        headers: {
          Cookie: `__Host-super_leader_session=${sessionToken}`,
        },
      });
      expect(resSecureName.status).toBe(200);
    } finally {
      await httpsCtx.stop();
    }
  });

  it("Cookie allows GET /v1/status, /v1/skills, /v1/commands/:id; rejects POST commands/messages/console-links and Daemon WS", async () => {
    const ctx = await createServerFixture({
      consolePublicUrl: "https://leader.example.com",
    });

    try {
      // Create session
      const issueRes = await fetch(`${ctx.baseUrl}/v1/console-links`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ctx.controllerToken}`,
        },
        body: JSON.stringify({ requestId: "req-permissions" }),
      });
      const { url } = await issueRes.json();
      const token = url.slice(url.indexOf("=") + 1);

      const exRes = await fetch(`${ctx.baseUrl}/auth/exchange`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://leader.example.com",
        },
        body: JSON.stringify({ token }),
      });
      const cookieHeader = exRes.headers.getSetCookie()[0].split(";")[0];

      // 1. Allowed GET endpoints
      const resStatus = await fetch(`${ctx.baseUrl}/v1/status`, {
        headers: { Cookie: cookieHeader },
      });
      expect(resStatus.status).toBe(200);

      const resSkills = await fetch(`${ctx.baseUrl}/v1/skills`, {
        headers: { Cookie: cookieHeader },
      });
      expect(resSkills.status).toBe(200);

      const resCommand = await fetch(`${ctx.baseUrl}/v1/commands/non-existent-cmd`, {
        headers: { Cookie: cookieHeader },
      });
      expect(resCommand.status).toBe(404); // reached route handler

      // 2. Prohibited mutations & link issuances
      const resPostCommands = await fetch(`${ctx.baseUrl}/v1/commands`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookieHeader,
        },
        body: JSON.stringify({
          nodeId: "demoair",
          sessionId: "s1",
          action: "read",
        }),
      });
      expect(resPostCommands.status).toBe(401);

      const resPostMessages = await fetch(`${ctx.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookieHeader,
        },
        body: JSON.stringify({
          chatId: "chat-1",
          messageId: "m1",
          text: "hello",
        }),
      });
      expect(resPostMessages.status).toBe(401);

      const resPostConsoleLinks = await fetch(`${ctx.baseUrl}/v1/console-links`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookieHeader,
        },
        body: JSON.stringify({ requestId: "req-forbidden" }),
      });
      expect(resPostConsoleLinks.status).toBe(401);

      // 3. Prohibited Daemon WS authentication via Cookie
      const ws = new WebSocket(`${ctx.wsUrl}/v1/daemon`, {
        headers: { Cookie: cookieHeader },
      });
      const wsErr = await new Promise<Error>((resolve) => {
        ws.on("error", resolve);
      });
      expect(wsErr.message).toContain("401");
    } finally {
      await ctx.stop();
    }
  });

  it("preserves machine Bearer token functionality across all endpoints", async () => {
    const ctx = await createServerFixture({
      consolePublicUrl: "https://leader.example.com",
    });

    try {
      const resStatus = await fetch(`${ctx.baseUrl}/v1/status`, {
        headers: { Authorization: `Bearer ${ctx.controllerToken}` },
      });
      expect(resStatus.status).toBe(200);

      const resLinks = await fetch(`${ctx.baseUrl}/v1/console-links`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ctx.controllerToken}`,
        },
        body: JSON.stringify({ requestId: "req-bearer" }),
      });
      expect(resLinks.status).toBe(200);
    } finally {
      await ctx.stop();
    }
  });

  it("enforces Origin verification: rejects mismatch, null, and cross-site Sec-Fetch-Site; Host spoofing cannot bypass", async () => {
    const ctx = await createServerFixture({
      consolePublicUrl: "https://leader.example.com",
    });

    try {
      const issueRes = await fetch(`${ctx.baseUrl}/v1/console-links`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ctx.controllerToken}`,
        },
        body: JSON.stringify({ requestId: "req-origin" }),
      });
      const { url } = await issueRes.json();
      const token = url.slice(url.indexOf("=") + 1);

      // Origin mismatch -> 401
      const resMismatch = await fetch(`${ctx.baseUrl}/auth/exchange`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://evil-attacker.site",
        },
        body: JSON.stringify({ token }),
      });
      expect(resMismatch.status).toBe(401);

      // Cross-site Sec-Fetch-Site -> 401
      const resCrossSite = await fetch(`${ctx.baseUrl}/auth/exchange`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Sec-Fetch-Site": "cross-site",
        },
        body: JSON.stringify({ token }),
      });
      expect(resCrossSite.status).toBe(401);

      // Host header spoofing attempt cannot bypass Origin check
      const resSpoof = await fetch(`${ctx.baseUrl}/auth/exchange`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Host: "evil-attacker.site",
          Origin: "https://evil-attacker.site",
        },
        body: JSON.stringify({ token }),
      });
      expect(resSpoof.status).toBe(401);
    } finally {
      await ctx.stop();
    }
  });

  it("handles session restoration and logout revocation with clearCookie", async () => {
    const ctx = await createServerFixture({
      consolePublicUrl: "https://leader.example.com",
    });

    try {
      const issueRes = await fetch(`${ctx.baseUrl}/v1/console-links`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ctx.controllerToken}`,
        },
        body: JSON.stringify({ requestId: "req-logout" }),
      });
      const { url } = await issueRes.json();
      const token = url.slice(url.indexOf("=") + 1);

      const exRes = await fetch(`${ctx.baseUrl}/auth/exchange`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://leader.example.com",
        },
        body: JSON.stringify({ token }),
      });
      const cookieHeader = exRes.headers.getSetCookie()[0].split(";")[0];

      // Session restore check
      const resSessionBefore = await fetch(`${ctx.baseUrl}/auth/session`, {
        headers: { Cookie: cookieHeader },
      });
      expect(resSessionBefore.status).toBe(200);
      const sessionData = await resSessionBefore.json();
      expect(sessionData.authenticated).toBe(true);

      // Logout
      const resLogout = await fetch(`${ctx.baseUrl}/auth/logout`, {
        method: "POST",
        headers: {
          Origin: "https://leader.example.com",
          Cookie: cookieHeader,
        },
      });
      expect(resLogout.status).toBe(200);

      const clearCookies = resLogout.headers.getSetCookie();
      expect(clearCookies[0]).toContain("__Host-super_leader_session=");
      // cookie expired or max-age=0/expires in past
      expect(clearCookies[0]).toMatch(/Expires=|Max-Age=0/i);

      // Subsequent /auth/session using old cookie returns 401
      const resSessionAfter = await fetch(`${ctx.baseUrl}/auth/session`, {
        headers: { Cookie: cookieHeader },
      });
      expect(resSessionAfter.status).toBe(401);
    } finally {
      await ctx.stop();
    }
  });

  it("applies no-store and no-referrer headers across all responses and masks internal errors without leaking secrets", async () => {
    const ctx = await createServerFixture({
      consolePublicUrl: "https://leader.example.com",
    });

    try {
      // 1. Success response headers
      const resHealth = await fetch(`${ctx.baseUrl}/health`);
      expect(resHealth.headers.get("Cache-Control")).toBe("no-store");
      expect(resHealth.headers.get("Referrer-Policy")).toBe("no-referrer");

      // 2. Auth error response headers
      const resAuthErr = await fetch(`${ctx.baseUrl}/auth/session`);
      expect(resAuthErr.status).toBe(401);
      expect(resAuthErr.headers.get("Cache-Control")).toBe("no-store");
      expect(resAuthErr.headers.get("Referrer-Policy")).toBe("no-referrer");

      // 3. Simulated async exception masks internal secret
      const secretToMask = "very_secret_database_credential_554433";
      const spy = vi.spyOn(ctx.store, "listRecentCommands").mockRejectedValueOnce(
        new Error(`Connection failed: ${secretToMask}`)
      );

      const resErr = await fetch(`${ctx.baseUrl}/v1/status`, {
        headers: { Authorization: `Bearer ${ctx.controllerToken}` },
      });
      expect(resErr.status).toBe(503);
      expect(resErr.headers.get("Cache-Control")).toBe("no-store");
      expect(resErr.headers.get("Referrer-Policy")).toBe("no-referrer");

      const bodyText = await resErr.text();
      expect(bodyText).not.toContain(secretToMask);

      spy.mockRestore();
    } finally {
      await ctx.stop();
    }
  });
});
