import { Request } from "express";

const HISTORY_PATH = /^\/sessions\/[^/]+\/[^/]+\/history\/?$/i;
const MESSAGE_PATH = /^\/sessions\/[^/]+\/[^/]+\/messages\/?$/i;
const MESSAGE_RECOVERY_PATH = /^\/sessions\/[^/]+\/[^/]+\/messages\/[^/]+\/?$/i;
const AUTOMATION_STATUS_PATH = /^\/automations\/[a-f\d-]{36}\/status\/?$/i;
const SETTINGS_READ_PATH = /^\/settings(?:\/models|\/resources(?:\/[a-z\d._-]+)?)?\/?$/i;
const SETTINGS_WRITE_PATH = /^\/settings\/(?:models(?:\/refresh)?|resources\/[a-z\d._-]+)\/?$/i;
export const CONSOLE_MESSAGE_INTENT = "session-message";

/** Browser credentials authorize only named workspace operations, never the admin API. */
export function isConsoleRead(req: Request): boolean {
  return req.method === "GET" && (
    /^\/(?:status|skills)\/?$/i.test(req.path) || SETTINGS_READ_PATH.test(req.path) || req.path === "/events" ||
    /^\/commands\/[^/]+\/?$/i.test(req.path) || HISTORY_PATH.test(req.path) || MESSAGE_RECOVERY_PATH.test(req.path) ||
    /^\/deliveries(?:\/[a-f\d-]{36}(?:\/(?:full|content))?)?\/?$/i.test(req.path) ||
    /^\/automations(?:\/[a-f\d-]{36}(?:\/runs)?)?\/?$/i.test(req.path)
  );
}

export function isConsoleMessage(req: Request): boolean {
  return req.method === "POST" && (MESSAGE_PATH.test(req.path) || AUTOMATION_STATUS_PATH.test(req.path) || SETTINGS_WRITE_PATH.test(req.path));
}

export function isSameOriginMessage(req: Request, expectedOrigin?: string): boolean {
  return Boolean(expectedOrigin && req.headers.origin === expectedOrigin &&
    req.is("application/json") &&
    req.headers["x-super-leader-intent"] === (SETTINGS_WRITE_PATH.test(req.path) ? "settings-update" : AUTOMATION_STATUS_PATH.test(req.path) ? "automation-status" : CONSOLE_MESSAGE_INTENT) &&
    (!req.headers["sec-fetch-site"] || req.headers["sec-fetch-site"] === "same-origin"));
}
