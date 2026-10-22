import { useState, useEffect, useRef, useCallback } from "react";
import {
  ControlPlaneStatusResponse,
  POLL_INTERVAL_MS,
  NodeStatus,
  ScopedSession,
} from "../../types";
import { fetchControlPlaneStatus, fetchControllerHealth } from "../../api/status";
import { fetchAuthSession } from "../../api/auth";
import { normalizeControlPlaneStatus } from "../../api/normalizers";
import { ApiAuthError } from "../../api/errors";
import { isCurrentAuthGeneration } from "../../auth/bootstrap";

export interface DerivedNodeStatus extends NodeStatus {
  /**
   * True when the node exists only in historical persisted sessions
   * and is not currently present in the live connected nodes map.
   */
  inferredOffline: boolean;
}

export interface PollingTelemetryState {
  data: ControlPlaneStatusResponse | null;
  derivedNodes: DerivedNodeStatus[];
  isLoading: boolean;
  isRefreshing: boolean;
  error: string | null;
  isAuthError: boolean;
  lastUpdatedAt: Date | null;
  consecutiveFailures: number;
  controllerHealthy: boolean | null;
  connectionState: "connecting" | "live" | "reconnecting" | "polling" | "offline";
  manualRefresh: () => void;
}

/**
 * Merges live nodes from hub.getNodeStatusList() with any nodeIds referenced
 * by persisted sessions so disconnected/offline nodes remain clearly visible
 * as OFFLINE in the operator console.
 */
export function buildDerivedNodes(
  nodes: NodeStatus[],
  sessions: ScopedSession[]
): DerivedNodeStatus[] {
  const byId = new Map<string, DerivedNodeStatus>();

  for (const node of nodes) {
    byId.set(node.nodeId, {
      ...node,
      inferredOffline: false,
    });
  }

  // Count sessions per nodeId in case a node disconnected and was removed from hub memory
  const sessionCounts = new Map<string, number>();
  const latestObserved = new Map<string, string>();

  for (const s of sessions) {
    sessionCounts.set(s.nodeId, (sessionCounts.get(s.nodeId) || 0) + 1);
    const prev = latestObserved.get(s.nodeId);
    if (!prev || s.observedAt > prev) {
      latestObserved.set(s.nodeId, s.observedAt);
    }
  }

  for (const [nodeId, count] of sessionCounts.entries()) {
    if (!byId.has(nodeId)) {
      byId.set(nodeId, {
        nodeId,
        connected: false,
        lastHeartbeat: latestObserved.get(nodeId) || "",
        sessionCount: count,
        inferredOffline: true,
      });
    }
  }

  return Array.from(byId.values()).sort((a, b) => {
    if (a.connected !== b.connected) {
      return a.connected ? -1 : 1;
    }
    return a.nodeId.localeCompare(b.nodeId);
  });
}

export function useStatusPolling(
  enabled: boolean,
  pollIntervalMs: number = POLL_INTERVAL_MS,
  onAuthFailure?: () => void,
  authGeneration?: number
): PollingTelemetryState {
  const [data, setData] = useState<ControlPlaneStatusResponse | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [isAuthError, setIsAuthError] = useState<boolean>(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [consecutiveFailures, setConsecutiveFailures] = useState<number>(0);
  const [controllerHealthy, setControllerHealthy] = useState<boolean | null>(
    null
  );

  const [connectionState, setConnectionState] = useState<PollingTelemetryState["connectionState"]>("offline");
  const manualRefreshRef = useRef<() => void>(() => {});
  const onAuthFailureRef = useRef(onAuthFailure);
  onAuthFailureRef.current = onAuthFailure;
  useEffect(() => {
    setIsAuthError(false);
    if (!enabled) {
      setData(null);
      setIsLoading(false);
      setIsRefreshing(false);
      setError(null);
      setIsAuthError(false);
      setLastUpdatedAt(null);
      setConsecutiveFailures(0);
      setControllerHealthy(null);
      setConnectionState("offline");
      manualRefreshRef.current = () => {};
      return;
    }
    let active = true;
    let rejected = false;
    let loaded = false;
    let live = false;
    let version = 0;
    let retries = 0;
    let source: EventSource | null = null;
    let pollAbort: AbortController | null = null;
    let authAbort: AbortController | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    let pollDeadline: ReturnType<typeof setTimeout> | undefined;
    let authDeadline: ReturnType<typeof setTimeout> | undefined;
    const current = () => active && (authGeneration === undefined || isCurrentAuthGeneration(authGeneration));
    const available = () => current() && !rejected && document.visibilityState !== "hidden" && navigator.onLine !== false;
    const clearTimers = () => {
      clearTimeout(pollTimer);
      clearTimeout(reconnectTimer);
      clearTimeout(connectTimer);
      pollTimer = reconnectTimer = connectTimer = undefined;
    };
    const closeSource = () => {
      source?.close();
      source = null;
      live = false;
      clearTimeout(connectTimer);
    };
    const suspend = () => {
      clearTimers();
      closeSource();
      pollAbort?.abort();
      authAbort?.abort();
      clearTimeout(pollDeadline);
      clearTimeout(authDeadline);
      setIsLoading(false);
      setIsRefreshing(false);
      setConnectionState("offline");
    };
    const rejectAuth = () => {
      if (!current() || rejected) return;
      rejected = true;
      suspend();
      setData(null);
      setLastUpdatedAt(null);
      setControllerHealthy(null);
      setIsAuthError(true);
      setError("会话登录已失效，请重新获取微信登录链接");
      onAuthFailureRef.current?.();
    };
    const accept = (payload: ControlPlaneStatusResponse) => {
      loaded = true;
      version++;
      setData(payload);
      setError(null);
      setIsAuthError(false);
      setConsecutiveFailures(0);
      setLastUpdatedAt(new Date());
      setIsLoading(false);
      setIsRefreshing(false);
    };
    const poll = async () => {
      // A timer or manual refresh never interrupts an already running request.
      if (!available() || pollAbort) return;
      clearTimeout(pollTimer);
      pollTimer = undefined;
      const abort = new AbortController();
      pollAbort = abort;
      const startedAtVersion = version;
      let timedOut = false;
      const deadline = setTimeout(() => {
        timedOut = true;
        if (available() && !live) {
          setError("状态查询超时，正在重试");
          setControllerHealthy(false);
          setConsecutiveFailures(previous => previous + 1);
        }
        abort.abort();
      }, REQUEST_DEADLINE_MS);
      pollDeadline = deadline;
      if (!live) setConnectionState("polling");
      if (loaded) setIsRefreshing(true);
      else setIsLoading(true);
      try {
        const [status, health] = await Promise.allSettled([
          fetchControlPlaneStatus(abort.signal).catch(failure => {
            // Authentication has priority over a slow public health probe or request timeout.
            if (failure instanceof ApiAuthError && available() && (!abort.signal.aborted || timedOut)) rejectAuth();
            throw failure;
          }), fetchControllerHealth(abort.signal),
        ]);
        if (!available() || abort.signal.aborted) return;
        if (status.status === "rejected") throw status.reason;
        if (startedAtVersion === version) {
          accept(status.value);
          setControllerHealthy(health.status === "fulfilled" && health.value.status === "ok");
        }
      } catch (failure) {
        if (!available() || abort.signal.aborted) return;
        if (failure instanceof ApiAuthError) rejectAuth();
        else {
          setError(failure instanceof Error ? failure.message : "无法连接至 Controller");
          setConsecutiveFailures(previous => previous + 1);
          setControllerHealthy(false);
        }
      } finally {
        clearTimeout(deadline);
        if (pollAbort === abort) pollAbort = null;
        if (available()) {
          setIsLoading(false);
          setIsRefreshing(false);
          if (!live) pollTimer = setTimeout(() => { void poll(); }, pollIntervalMs);
        }
      }
    };
    const recover = async () => {
      closeSource();
      if (!available() || authAbort) return;
      setConnectionState("reconnecting");
      const abort = new AbortController();
      authAbort = abort;
      const deadline = setTimeout(() => abort.abort(), REQUEST_DEADLINE_MS);
      authDeadline = deadline;
      try {
        const session = await fetchAuthSession(abort.signal);
        if (!session.authenticated && available()) rejectAuth();
      } catch (failure) {
        if (failure instanceof ApiAuthError && available() && !abort.signal.aborted) rejectAuth();
        else if (available() && !abort.signal.aborted) setControllerHealthy(false);
      } finally {
        clearTimeout(deadline);
        if (authAbort === abort) authAbort = null;
        if (available()) {
          clearTimeout(pollTimer);
          void poll();
          const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(retries++, MAX_RECONNECT_EXPONENT));
          reconnectTimer = setTimeout(connect, delay);
        }
      }
    };
    const connect = () => {
      if (!available() || source) return;
      if (typeof EventSource === "undefined") {
        void poll();
        return;
      }
      setConnectionState(retries ? "reconnecting" : "connecting");
      if (!loaded) setIsLoading(true);
      try {
        const stream = new EventSource("/v1/events");
        source = stream;
        connectTimer = setTimeout(() => { if (source === stream) void recover(); }, REQUEST_DEADLINE_MS);
        stream.addEventListener("status", event => {
          if (!available() || source !== stream) return;
          try {
            const payload = normalizeControlPlaneStatus(JSON.parse((event as MessageEvent<string>).data));
            accept(payload);
            live = true;
            retries = 0;
            clearTimers();
            setConnectionState("live");
            setControllerHealthy(true);
          } catch {
            setError("实时状态格式无效，正在重新连接");
            void recover();
          }
        });
        stream.addEventListener("auth-expired", () => { if (source === stream) rejectAuth(); });
        stream.onerror = () => { if (source === stream) void recover(); };
      } catch {
        void recover();
      }
    };
    const resume = () => {
      if (!current()) return;
      if (!available()) suspend();
      else connect();
    };
    manualRefreshRef.current = () => { if (available()) void poll(); };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", resume);
    window.addEventListener("offline", resume);
    resume();
    return () => {
      active = false;
      clearTimers();
      closeSource();
      pollAbort?.abort();
      authAbort?.abort();
      clearTimeout(pollDeadline);
      clearTimeout(authDeadline);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("online", resume);
      window.removeEventListener("offline", resume);
      manualRefreshRef.current = () => {};
    };
  }, [enabled, pollIntervalMs, authGeneration]);

  const manualRefresh = useCallback(() => manualRefreshRef.current(), []);

  const derivedNodes = data
    ? buildDerivedNodes(data.nodes, data.sessions)
    : [];

  return {
    data,
    derivedNodes,
    isLoading,
    isRefreshing,
    error,
    isAuthError,
    lastUpdatedAt,
    consecutiveFailures,
    controllerHealthy,
    connectionState,
    manualRefresh,
  };
}

const REQUEST_DEADLINE_MS = 20_000;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const MAX_RECONNECT_EXPONENT = 5;
