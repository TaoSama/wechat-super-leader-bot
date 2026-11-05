import { useCallback, useEffect, useRef, useState } from "react";
import { ApiAuthError, ApiHttpError } from "../../api/errors";
import { getAuthSessionSnapshot, setUnauthenticatedSession } from "../../auth/bootstrap";

const UNCONFIRMED_MESSAGE = "提交结果尚未确认，请刷新状态核查；未修改内容时重试不会重复创建。";

/**
 * One idempotency key per submitted content: retries of an unchanged form reuse it,
 * while editing the form or a confirmed success starts a new key.
 */
export function useAuthorizationSubmit() {
  const key = useRef<string | null>(null);
  const active = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const replacedRef = useRef(false);
  const [replaced, setReplaced] = useState(false);
  useEffect(() => () => active.current?.abort(), []);
  const resetKey = useCallback(() => { key.current = null; }, []);

  async function run<T>(operation: (requestId: string, signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
    if (active.current) return undefined;
    key.current ??= crypto.randomUUID();
    const controller = new AbortController(), generation = getAuthSessionSnapshot().generation;
    active.current = controller;
    setBusy(true);
    setError(undefined);
    try {
      const result = await operation(key.current, controller.signal);
      key.current = null;
      return result;
    } catch (cause) {
      if (controller.signal.aborted) return undefined;
      if (cause instanceof ApiAuthError) { setUnauthenticatedSession("expired", generation); return undefined; }
      setError(cause instanceof ApiHttpError ? cause.message : UNCONFIRMED_MESSAGE);
      return undefined;
    } finally {
      if (!controller.signal.aborted) { active.current = null; setBusy(false); }
    }
  }
  /** Edit = cancel the frozen original once, then create; a failed create retries only the create. */
  function runReplacing<T>(replacingId: string | undefined, cancel: (id: string, requestId: string, signal: AbortSignal) => Promise<unknown>,
    create: (requestId: string, signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
    return run(async (requestId, signal) => {
      if (replacingId && !replacedRef.current) {
        await cancel(replacingId, `${requestId}_cancel`, signal);
        replacedRef.current = true;
        setReplaced(true);
      }
      return create(`${requestId}_create`, signal);
    });
  }
  return { busy, error, replaced, run, runReplacing, resetKey };
}
