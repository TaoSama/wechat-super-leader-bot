import type { NodeHub } from "../nodes/hub.js";
import { SendAvailabilitySchema, type SendRoute, type Session } from "../types.js";
import { isDesktopObservationFresh } from "./observation.js";
import { selectSendRoute } from "./send-eligibility.js";

export const SEND_READINESS_WAIT_MS = 10_000;
export type ReadinessTarget = { nodeId: string; sessionId: string; sendRoute?: SendRoute };
export type ReadinessHub = Pick<NodeHub, "isNodeConnected" | "getNodeSession"> &
  Partial<Pick<NodeHub, "subscribeSessionChanges">>;
type ReadinessResult = { ready: true; routes: SendRoute[] } | { ready: false; target: ReadinessTarget; reason: string };
const denied = (target: ReadinessTarget, reason: string): ReadinessResult => ({ ready: false, target, reason });

function checking(session: Session, now: number): boolean {
  const parsed = SendAvailabilitySchema.safeParse(session.sendAvailability);
  return parsed.success && parsed.data.route === "desktop-owner" && parsed.data.state === "blocked" &&
    parsed.data.reason === "checking" && session.desktopObservation?.status === "idle" &&
    isDesktopObservationFresh(session.desktopObservation, now);
}

function blockedReason(session: Session, fallback: string): string {
  if (session.desktopObservation?.availability === "unavailable") {
    return "无法获取原桌面控制端；请先在原 Codex 桌面打开该会话，加载后重试（当前观测不能确定不可用的具体原因）";
  }
  if (session.sendAvailability?.state === "unavailable") return "发送通道不可用";
  if (session.desktopObservation?.status === "active") return "桌面会话忙碌";
  switch (session.sendAvailability?.reason) {
    case "busy": return "会话忙碌";
    case "unavailable": return "发送通道不可用";
    case "preflight-rejected": return "发送资格检查未通过";
    case "checking": return "发送资格仍在检查，桌面空闲观测已不可用或过期";
    default: return fallback;
  }
}

/** Wait only for known, freshly idle desktop targets already undergoing a probe. */
export function waitForSendReadiness(hub: ReadinessHub, targets: readonly ReadinessTarget[],
  options: { signal?: AbortSignal; timeoutMs?: number; now?: () => number } = {}): Promise<ReadinessResult> {
  const now = options.now ?? Date.now;
  const waitingRoutes = new Map<string, SendRoute>();
  const inspect = (): ReadinessResult | ReadinessTarget => {
    let pending: ReadinessTarget | undefined;
    const routes: SendRoute[] = [];
    for (const target of targets) {
      if (!hub.isNodeConnected(target.nodeId)) return denied(target, "节点已断开连接");
      const session = hub.getNodeSession(target.nodeId, target.sessionId);
      if (!session) return denied(target, "目标会话已不可用");
      const key = JSON.stringify([target.nodeId, target.sessionId]);
      const expectedRoute = target.sendRoute ?? waitingRoutes.get(key);
      const eligibility = selectSendRoute(session, now());
      if (eligibility.ready) {
        if (expectedRoute && expectedRoute !== eligibility.route) return denied(target, "发送路线已变化，请重新生成计划");
        waitingRoutes.set(key, eligibility.route);
        routes.push(eligibility.route);
      } else if (checking(session, now()) && (!expectedRoute || expectedRoute === "desktop-owner")) {
        waitingRoutes.set(key, "desktop-owner");
        pending ??= target;
      } else return denied(target, blockedReason(session, eligibility.reason));
    }
    return pending ?? { ready: true, routes };
  };
  const initial = inspect();
  if ("ready" in initial) return Promise.resolve(initial);
  const timeoutMs = Math.max(0, Math.min(options.timeoutMs ?? SEND_READINESS_WAIT_MS, SEND_READINESS_WAIT_MS));
  if (!hub.subscribeSessionChanges || timeoutMs === 0 || options.signal?.aborted) {
    return Promise.resolve(denied(initial, options.signal?.aborted ? "等待发送资格已取消" : "发送资格检查尚未完成，未派发"));
  }
  return new Promise(resolve => {
    let finished = false;
    const cleanups: (() => void)[] = [];
    const finish = (result: ReadinessResult) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", aborted);
      for (const cleanup of cleanups) cleanup();
      resolve(result);
    };
    const changed = () => {
      const result = inspect();
      if ("ready" in result) finish(result);
    };
    const aborted = () => finish(denied(initial, "等待发送资格已取消"));
    const timer = setTimeout(() => {
      const result = inspect();
      finish("ready" in result ? result : denied(result, "发送资格检查超时，尚未取得 ready，未派发"));
    }, timeoutMs);
    for (const nodeId of new Set(targets.map(target => target.nodeId))) {
      cleanups.push(hub.subscribeSessionChanges!(nodeId, changed));
    }
    options.signal?.addEventListener("abort", aborted, { once: true });
    if (options.signal?.aborted) aborted();
    else changed();
  });
}

export function readinessFailure(result: Extract<ReadinessResult, { ready: false }>): string {
  return `[${result.target.nodeId}] ${result.target.sessionId}：${result.reason}`;
}
