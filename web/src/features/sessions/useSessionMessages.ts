import { useCallback, useEffect, useRef, useState } from "react";
import { ApiAuthError, ApiHttpError } from "../../api/errors";
import { fetchCommand, sendSessionMessage } from "../../api/sessions";
import { CommandRecord, POLL_INTERVAL_MS, ScopedSession } from "../../types";
import { sessionKey } from "./useSessionHistory";
import { sessionSendBlockReason } from "./send-availability";

const MAX_COMMAND_POLLS = 60;

interface Submission {
  requestId: string;
  prompt: string;
  command?: CommandRecord;
  uncertain: boolean;
}
interface MessageState {
  draft: string;
  sending: boolean;
  error?: string;
  submission?: Submission;
  pollingStopped?: boolean;
}
const EMPTY: MessageState = { draft: "", sending: false };

export function sendBlockReason(session: ScopedSession | null, connected: boolean, stale: boolean, now = Date.now()): string | null {
  if (!session) return "请选择一个会话";
  if (!connected) return "机器离线，恢复连接后再发送";
  if (stale) return "会话状态待更新，请先刷新";
  return sessionSendBlockReason(session, now);
}

export function useSessionMessages(session: ScopedSession | null, onAuthFailure: () => void) {
  const owner = session ? sessionKey(session) : "";
  const [states, setStates] = useState<Record<string, MessageState>>({});
  const activeRef = useRef<AbortController | null>(null);
  const lockRef = useRef(false);
  const authRef = useRef(onAuthFailure);
  authRef.current = onAuthFailure;
  const state = states[owner] ?? EMPTY;
  const update = useCallback((key: string, patch: Partial<MessageState>) => {
    setStates((previous) => ({ ...previous, [key]: { ...(previous[key] ?? EMPTY), ...patch } }));
  }, []);

  useEffect(() => {
    return () => {
      activeRef.current?.abort();
      activeRef.current = null;
      lockRef.current = false;
      if (owner) update(owner, { sending: false });
    };
  }, [owner, update]);

  const submit = async (recover = false) => {
    if (!session || lockRef.current) return;
    const prior = state.submission;
    if (recover && !prior) return;
    if (!recover && prior && (prior.uncertain || prior.command?.status === "pending" || prior.command?.status === "accepted" || prior.command?.status === "uncertain")) return;
    const submission: Submission = recover && prior ? prior : { requestId: crypto.randomUUID(), prompt: state.draft.trim(), uncertain: true };
    if (!submission.prompt) return;
    const target = session;
    const key = owner;
    const controller = new AbortController();
    activeRef.current = controller;
    lockRef.current = true;
    update(key, { sending: true, error: undefined, submission, pollingStopped: false });
    try {
      const command = recover && submission.command
        ? await fetchCommand(submission.command.commandId, controller.signal)
        : await sendSessionMessage(target.nodeId, target.id, submission.prompt, submission.requestId, controller.signal);
      if (controller.signal.aborted) return;
      if (command.nodeId !== target.nodeId || command.sessionId !== target.id) throw new Error("回执与目标会话不匹配");
      const uncertain = command.status === "uncertain";
      update(key, { submission: { ...submission, command, uncertain }, draft: uncertain || command.status === "failed" ? state.draft : "", error: command.error });
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ApiAuthError) { authRef.current(); return; }
      // Only explicit client rejections prove that no command was accepted.
      const rejected = error instanceof ApiHttpError && error.statusCode >= 400 && error.statusCode < 500;
      update(key, { submission: rejected ? undefined : { ...submission, uncertain: true }, error: rejected ? error.message : "提交结果尚不确定。请保留原请求，手动核查或恢复。" });
    } finally {
      if (activeRef.current === controller) {
        activeRef.current = null;
        lockRef.current = false;
        update(key, { sending: false });
      }
    }
  };

  const command = state.submission?.command;
  useEffect(() => {
    if (!command || state.sending || state.pollingStopped || !["pending", "accepted"].includes(command.status)) return;
    let disposed = false;
    let timer: number;
    let controller: AbortController | null = null;
    let count = 0;
    const targetCommand = command;
    async function poll() {
      controller = new AbortController();
      try {
        const receipt = await fetchCommand(targetCommand.commandId, controller.signal);
        if (disposed) return;
        if (receipt.nodeId !== targetCommand.nodeId || receipt.sessionId !== targetCommand.sessionId) throw new Error("命令回执目标不匹配");
        setStates((previous) => {
          const current = previous[owner];
          if (!current?.submission) return previous;
          const needsDraft = receipt.status === "failed" || receipt.status === "uncertain";
          return { ...previous, [owner]: { ...current, draft: needsDraft ? current.draft || current.submission.prompt : current.draft, submission: { ...current.submission, command: receipt, uncertain: receipt.status === "uncertain" }, error: receipt.error } };
        });
        if (!disposed && ["pending", "accepted"].includes(receipt.status)) {
          count++;
          if (count < MAX_COMMAND_POLLS) timer = window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
          else update(owner, { pollingStopped: true });
        }
      } catch (error) {
        if (disposed) return;
        if (error instanceof ApiAuthError) { authRef.current(); return; }
        update(owner, { error: "无法更新发送回执，请手动核查。", pollingStopped: true });
      }
    }
    timer = window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
    return () => { disposed = true; window.clearTimeout(timer); controller?.abort(); };
  }, [owner, command?.commandId, command?.status, state.sending, state.pollingStopped, update]);

  return { ...state, setDraft: (draft: string) => update(owner, { draft }), submit };
}
