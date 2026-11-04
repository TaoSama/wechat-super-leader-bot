import { useCallback, useEffect, useRef, useState } from "react";
import { ApiAuthError, ApiHttpError } from "../../api/errors";
import { fetchCommand, interruptSession } from "../../api/sessions";
import { CommandRecord, POLL_INTERVAL_MS, ScopedSession } from "../../types";
import { sessionKey } from "./useSessionHistory";

const MAX_INTERRUPT_POLLS = 30;
const INTERRUPT_POLLING_STATUSES = ["pending"];
export const INTERRUPT_UNCERTAIN_MESSAGE = "停止结果不确定，请核查会话状态";

export interface InterruptRequest {
  requestId: string;
  turnId: string;
  command?: CommandRecord;
  uncertain: boolean;
}
interface InterruptState {
  request?: InterruptRequest;
  busy: boolean;
  error?: string;
  pollingStopped?: boolean;
}
const EMPTY: InterruptState = { busy: false };

/** One stop request per session; an unknown outcome is only ever recovered with the same requestId. */
export function useSessionInterrupt(session: ScopedSession | null, onAuthFailure: () => void, onCompleted?: () => void) {
  const owner = session ? sessionKey(session) : "";
  const [states, setStates] = useState<Record<string, InterruptState>>({});
  const activeRef = useRef<AbortController | null>(null);
  const authRef = useRef(onAuthFailure);
  const completedRef = useRef(onCompleted);
  authRef.current = onAuthFailure;
  completedRef.current = onCompleted;
  const state = states[owner] ?? EMPTY;
  const update = useCallback((key: string, patch: Partial<InterruptState>) => {
    setStates(previous => ({ ...previous, [key]: { ...(previous[key] ?? EMPTY), ...patch } }));
  }, []);
  const settle = useCallback((key: string, request: InterruptRequest, command: CommandRecord) => {
    const uncertain = command.status === "uncertain";
    update(key, { request: { ...request, command, uncertain }, error: command.status === "failed" ? command.error ?? "停止未成功" : uncertain ? INTERRUPT_UNCERTAIN_MESSAGE : undefined });
    if (command.status === "completed") completedRef.current?.();
  }, [update]);

  useEffect(() => () => { activeRef.current?.abort(); activeRef.current = null; if (owner) update(owner, { busy: false }); }, [owner, update]);

  const interrupt = async (turnId: string, recover = false) => {
    if (!session || activeRef.current) return;
    const prior = state.request;
    if (recover && !prior) return;
    if (!recover && prior && (prior.uncertain || INTERRUPT_POLLING_STATUSES.includes(prior.command?.status ?? "") && prior.turnId === turnId)) return;
    const request: InterruptRequest = recover && prior ? prior : { requestId: crypto.randomUUID(), turnId, uncertain: true };
    const key = owner, target = session;
    const controller = new AbortController();
    activeRef.current = controller;
    update(key, { busy: true, error: undefined, request, pollingStopped: false });
    try {
      const command = await interruptSession(target.nodeId, target.id, request.turnId, request.requestId, controller.signal);
      if (!controller.signal.aborted) settle(key, request, command);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ApiAuthError) { authRef.current(); return; }
      // Only an explicit client rejection proves that no stop request was started.
      const rejected = error instanceof ApiHttpError && error.statusCode >= 400 && error.statusCode < 500;
      update(key, { request: rejected ? undefined : { ...request, uncertain: true }, error: rejected ? `未能停止：${error.message}` : INTERRUPT_UNCERTAIN_MESSAGE });
    } finally {
      if (activeRef.current === controller) { activeRef.current = null; update(key, { busy: false }); }
    }
  };

  const command = state.request?.command;
  useEffect(() => {
    if (!command || state.busy || state.pollingStopped || !INTERRUPT_POLLING_STATUSES.includes(command.status)) return;
    const request = state.request!;
    let disposed = false, count = 0, timer: number;
    let controller: AbortController | null = null;
    async function poll() {
      controller = new AbortController();
      try {
        const receipt = await fetchCommand(command!.commandId, controller.signal);
        if (disposed) return;
        if (receipt.action !== "interrupt" || receipt.nodeId !== command!.nodeId || receipt.sessionId !== command!.sessionId) throw new Error("停止回执目标不匹配");
        settle(owner, request, receipt);
        if (INTERRUPT_POLLING_STATUSES.includes(receipt.status)) {
          if (++count < MAX_INTERRUPT_POLLS) timer = window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
          else update(owner, { pollingStopped: true, error: INTERRUPT_UNCERTAIN_MESSAGE });
        }
      } catch (error) {
        if (disposed) return;
        if (error instanceof ApiAuthError) { authRef.current(); return; }
        update(owner, { pollingStopped: true, error: INTERRUPT_UNCERTAIN_MESSAGE });
      }
    }
    timer = window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
    return () => { disposed = true; window.clearTimeout(timer); controller?.abort(); };
  }, [owner, command?.commandId, command?.status, state.busy, state.pollingStopped, settle, update]);

  return { ...state, interrupt };
}
