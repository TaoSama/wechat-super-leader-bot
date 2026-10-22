/**
 * Super Leader Web Console - One-Time Token & Session Authentication Helper
 *
 * Rules:
 * 1. Synchronously extract token from URL fragment (#login=<token>) and clear both hash and search
 *    via history.replaceState to prevent token leakage in history, logs, or Referer.
 * 2. Fail-closed: If history.replaceState throws or is unavailable, reject extraction immediately
 *    so un-cleared tokens are never exchanged.
 * 3. Strictly in-memory: NEVER write tokens to localStorage, sessionStorage, or console logs.
 * 4. Module-shared promise: All mounts (including React StrictMode initial + cleanup + remount)
 *    subscribe to the exact same initialization sequence, eliminating race-401 and double-POST.
 * 5. Minimal hashchange listener: If an already-opened tab receives a new #login= hash,
 *    immediately extract & sanitize the URL and re-trigger a fresh auth initialization.
 */

import { AuthState, AuthReason } from "../types";
import { exchangeLoginToken, fetchAuthSession } from "../api/auth";

declare global {
  interface Window {
    __SUPER_LEADER_LOGIN_TOKEN__?: string;
    __SUPER_LEADER_LOGIN_ERROR__?: string;
  }
}

const EXACT_TOKEN_REGEX = /^[A-Za-z0-9_-]{43}$/;

let sharedAuthInitPromise: Promise<AuthState> | null = null;
let authInitAbort: AbortController | null = null;
export interface AuthSessionSnapshot {
  generation: number;
  state: AuthState;
}
let authSessionSnapshot: AuthSessionSnapshot = { generation: 0, state: { status: "checking" } };
const authStateSubscribers = new Set<(state: AuthState) => void>();
const authSessionSubscribers = new Set<(snapshot: AuthSessionSnapshot) => void>();

export function getAuthSessionSnapshot(): AuthSessionSnapshot {
  return authSessionSnapshot;
}

export function isCurrentAuthGeneration(generation: number): boolean {
  return generation === authSessionSnapshot.generation;
}

export function resetAuthHelperForTesting(): void {
  authInitAbort?.abort();
  authInitAbort = null;
  sharedAuthInitPromise = null;
  authSessionSnapshot = { generation: authSessionSnapshot.generation + 1, state: { status: "checking" } };
  authStateSubscribers.clear();
  authSessionSubscribers.clear();
}

export function setUnauthenticatedSession(reason: AuthReason = "none", expectedGeneration?: number): boolean {
  if (expectedGeneration !== undefined && !isCurrentAuthGeneration(expectedGeneration)) return false;
  authInitAbort?.abort();
  authInitAbort = null;
  const state: AuthState = { status: "unauthenticated", reason };
  sharedAuthInitPromise = Promise.resolve(state);
  publishAuthState(state, authSessionSnapshot.generation + 1);
  return true;
}

function publishAuthState(state: AuthState, generation: number): void {
  const snapshot = { state, generation };
  authSessionSnapshot = snapshot;
  for (const subscriber of authSessionSubscribers) {
    if (authSessionSnapshot !== snapshot) return;
    subscriber(snapshot);
  }
  for (const subscriber of authStateSubscribers) {
    if (authSessionSnapshot !== snapshot) return;
    subscriber(state);
  }
}

export function subscribeAuthSession(callback: (snapshot: AuthSessionSnapshot) => void): () => void {
  authSessionSubscribers.add(callback);
  return () => { authSessionSubscribers.delete(callback); };
}

/**
 * Subscribes a callback to auth state changes (e.g. from in-tab hashchange navigation).
 */
export function subscribeAuthState(callback: (state: AuthState) => void): () => void {
  authStateSubscribers.add(callback);
  return () => {
    authStateSubscribers.delete(callback);
  };
}

/**
 * Extracts and sanitizes the address bar. If a login= fragment is present,
 * it strips both hash and query string immediately.
 *
 * Returns the 43-character token if valid, or null if absent / invalid / failed.
 */
export function extractAndClearLoginToken(
  targetWindow: Window = typeof window !== "undefined" ? window : (undefined as unknown as Window)
): string | null {
  if (!targetWindow || !targetWindow.location) {
    return null;
  }

  // Check if bootstrap script already registered an error
  if (targetWindow.__SUPER_LEADER_LOGIN_ERROR__) {
    delete targetWindow.__SUPER_LEADER_LOGIN_ERROR__;
    delete targetWindow.__SUPER_LEADER_LOGIN_TOKEN__;
    return null;
  }

  // Check if early bootstrap script in index.html already grabbed and sanitized it
  if (typeof targetWindow.__SUPER_LEADER_LOGIN_TOKEN__ === "string" && targetWindow.__SUPER_LEADER_LOGIN_TOKEN__.trim()) {
    const raw = targetWindow.__SUPER_LEADER_LOGIN_TOKEN__.trim();
    delete targetWindow.__SUPER_LEADER_LOGIN_TOKEN__;
    if (EXACT_TOKEN_REGEX.test(raw)) {
      return raw;
    }
    return null;
  }

  const hash = targetWindow.location.hash || "";
  if (!hash || hash.indexOf("login=") === -1) {
    return null;
  }

  // Address bar contains login= -> MUST sanitize address bar immediately
  if (!targetWindow.history || typeof targetWindow.history.replaceState !== "function") {
    // History API unavailable -> fail closed
    return null;
  }

  try {
    const cleanPath = targetWindow.location.pathname || "/";
    targetWindow.history.replaceState(null, "", cleanPath);
  } catch (_err) {
    // replaceState failed -> fail closed
    return null;
  }

  const match = hash.match(/(?:^#|[&#])login=([A-Za-z0-9_-]+)(?:$|[&#])/);
  if (!match || !match[1] || !EXACT_TOKEN_REGEX.test(match[1])) {
    // Address bar cleared, but token format invalid -> refuse exchange
    return null;
  }

  return match[1];
}

/**
 * Module-level shared authorization initialization.
 * Subscribed by any App mount.
 */
export function getOrInitAuthSession(
  targetWindow: Window = typeof window !== "undefined" ? window : (undefined as unknown as Window),
  forceFresh = false
): Promise<AuthState> {
  if (sharedAuthInitPromise && !forceFresh) {
    return sharedAuthInitPromise;
  }

  authInitAbort?.abort();
  const abort = new AbortController();
  authInitAbort = abort;
  const generation = authSessionSnapshot.generation + 1;
  const checking: AuthState = { status: "checking" };
  authSessionSnapshot = { state: checking, generation };
  sharedAuthInitPromise = (async (): Promise<AuthState> => {
    // 1. Check bootstrap error
    if (targetWindow && targetWindow.__SUPER_LEADER_LOGIN_ERROR__) {
      delete targetWindow.__SUPER_LEADER_LOGIN_ERROR__;
      delete targetWindow.__SUPER_LEADER_LOGIN_TOKEN__;
      return { status: "unauthenticated", reason: "invalid_link" };
    }

    // 2. Extract token from bootstrap global or URL
    const hash = targetWindow && targetWindow.location ? targetWindow.location.hash || "" : "";
    const hasHashLogin = hash.indexOf("login=") !== -1;
    const token = extractAndClearLoginToken(targetWindow);

    if (token) {
      try {
        const res = await exchangeLoginToken(token, abort.signal);
        return { status: "authenticated", expiresAt: res.expiresAt };
      } catch (_err) {
        return { status: "unauthenticated", reason: "invalid_link" };
      }
    }

    if (hasHashLogin) {
      // There was a login= in the hash, but extraction returned null (e.g. invalid format or sanitize error)
      return { status: "unauthenticated", reason: "invalid_link" };
    }

    // 3. No token present -> verify existing HttpOnly session cookie (e.g. page refresh)
    try {
      const session = await fetchAuthSession(abort.signal);
      if (session.authenticated) {
        return { status: "authenticated", expiresAt: session.expiresAt };
      }
      return { status: "unauthenticated", reason: "none" };
    } catch (_err) {
      return { status: "unauthenticated", reason: "none" };
    }
  })().then((state) => {
    // Superseded requests adopt the current initialization instead of publishing old results.
    if (!isCurrentAuthGeneration(generation)) {
      return sharedAuthInitPromise ?? authSessionSnapshot.state;
    }
    authInitAbort = null;
    publishAuthState(state, generation);
    return state;
  });

  publishAuthState(checking, generation);
  return sharedAuthInitPromise;
}

/**
 * Handle in-tab #login hash navigation without full reload.
 */
export function handleHashChangeLogin(
  targetWindow: Window = typeof window !== "undefined" ? window : (undefined as unknown as Window)
): Promise<AuthState> | null {
  if (!targetWindow || !targetWindow.location) {
    return null;
  }
  const hash = targetWindow.location.hash || "";
  if (hash.indexOf("login=") === -1) {
    return null;
  }

  return getOrInitAuthSession(targetWindow, true);
}

if (typeof window !== "undefined") {
  window.addEventListener("hashchange", () => {
    handleHashChangeLogin(window);
  });
}
