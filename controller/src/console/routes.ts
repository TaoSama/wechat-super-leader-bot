import express, { Request, Response, Router } from "express";
import { ConsoleAuthService, CONSOLE_SESSION_TTL_MS } from "./auth.js";

export function getSessionCookieName(isSecure: boolean): string {
  return isSecure ? "__Host-super_leader_session" : "super_leader_session";
}

export function extractSessionCookie(req: Request, isSecure: boolean): string | null {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader || typeof cookieHeader !== "string") {
    return null;
  }

  const targetName = getSessionCookieName(isSecure);
  const parts = cookieHeader.split(";");
  for (const part of parts) {
    const eqIdx = part.indexOf("=");
    if (eqIdx > 0) {
      const name = part.slice(0, eqIdx).trim();
      const val = part.slice(eqIdx + 1).trim();
      if (name === targetName && val.length > 0) {
        return val;
      }
    }
  }

  return null;
}

export function checkOriginMatches(req: Request, expectedOrigin: string | undefined): boolean {
  if (!expectedOrigin) {
    return false;
  }
  const originHeader = req.headers.origin;
  if (typeof originHeader === "string" && originHeader.trim().length > 0) {
    return originHeader.trim().toLowerCase() === expectedOrigin.toLowerCase();
  }
  // If Origin header is omitted, check Sec-Fetch-Site to block cross-site
  const secFetchSite = req.headers["sec-fetch-site"];
  if (secFetchSite && secFetchSite !== "same-origin" && secFetchSite !== "none") {
    return false;
  }
  return true;
}

export function createConsoleAuthRouter(authService: ConsoleAuthService): Router {
  const router = express.Router();

  // Apply no-store and no-referrer unconditionally across all /auth routes
  router.use((_req: Request, res: Response, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });

  const expectedOrigin = authService.getPublicUrl();
  const isSecure = expectedOrigin !== undefined && new URL(expectedOrigin).protocol === "https:";
  const cookieName = getSessionCookieName(isSecure);

  // POST /auth/exchange
  router.post("/exchange", async (req: Request, res: Response): Promise<void> => {
    if (!expectedOrigin || !checkOriginMatches(req, expectedOrigin)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    if (!req.is("application/json") || !req.body || typeof req.body !== "object" ||
        Array.isArray(req.body) || Object.keys(req.body).length !== 1 || !Object.hasOwn(req.body, "token")) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const token = req.body.token;
    if (typeof token !== "string" || token.trim().length === 0) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const result = await authService.exchangeToken(token);
    if (!result) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    res.cookie(cookieName, result.sessionToken, {
      httpOnly: true,
      secure: isSecure,
      sameSite: "strict",
      path: "/",
      maxAge: CONSOLE_SESSION_TTL_MS,
    });

    res.status(200).json({
      authenticated: true,
      expiresAt: result.expiresAt,
    });
  });

  // GET /auth/session
  router.get("/session", async (req: Request, res: Response): Promise<void> => {
    const sessionToken = extractSessionCookie(req, isSecure);
    if (!sessionToken) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const session = await authService.verifySession(sessionToken);
    if (!session) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    res.status(200).json({
      authenticated: true,
      expiresAt: session.expiresAt,
    });
  });

  // POST /auth/logout
  router.post("/logout", async (req: Request, res: Response): Promise<void> => {
    if (!expectedOrigin || !checkOriginMatches(req, expectedOrigin)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const sessionToken = extractSessionCookie(req, isSecure);
    if (sessionToken) {
      await authService.deleteSession(sessionToken);
    }

    res.clearCookie(cookieName, {
      httpOnly: true,
      secure: isSecure,
      sameSite: "strict",
      path: "/",
    });

    res.status(200).json({ authenticated: false });
  });

  return router;
}
