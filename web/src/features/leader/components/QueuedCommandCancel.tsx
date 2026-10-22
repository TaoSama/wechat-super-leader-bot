import { useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "../../../components/ui/ConfirmDialog";
import { ApiAuthError, ApiHttpError } from "../../../api/errors";
import { cancelSessionMessage } from "../../../api/sessions";
import { setUnauthenticatedSession } from "../../../auth/bootstrap";
import type { CommandRecord } from "../../../types";

const WEB_REQUEST_ID = /^web_[a-f0-9]{64}$/;

export function canCancelWebQueue(command: CommandRecord): boolean {
  return command.status === "queued" && command.action === "send" && WEB_REQUEST_ID.test(command.requestId) &&
    command.sendRoute !== "terminal-pane" && !command.sessionId.startsWith("terminal:");
}

export function QueuedCommandCancel({ command, onReceipt }: { command: CommandRecord; onReceipt: (receipt: CommandRecord) => void }) {
  const active = useRef<AbortController | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => () => active.current?.abort(), []);

  async function cancel() {
    if (active.current || !canCancelWebQueue(command)) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError(undefined);
    try {
      const receipt = await cancelSessionMessage(command.nodeId, command.sessionId, command.commandId, controller.signal);
      if (!controller.signal.aborted) onReceipt(receipt);
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (cause instanceof ApiAuthError) { setUnauthenticatedSession("expired"); return; }
      setError(cause instanceof ApiHttpError && cause.statusCode === 409
        ? "无法取消：请求已开始发送，或不属于当前登录。请刷新状态核查。"
        : "取消结果尚未确认，请刷新状态核查原请求。");
    } finally {
      if (!controller.signal.aborted) { active.current = null; setBusy(false); setConfirmOpen(false); }
    }
  }

  return <div className="command-queue-action">
    <button type="button" className="ui-button ghost" disabled={busy} onClick={() => setConfirmOpen(true)}>取消排队</button>
    {confirmOpen && <ConfirmDialog title="取消排队消息" description="仅移除这条尚未发送的消息；如果请求已开始发送，将无法取消。" confirmLabel="确认取消排队" onConfirm={() => void cancel()} onClose={() => setConfirmOpen(false)} busy={busy} destructive />}
    {error && <p role="alert" className="command-error">{error}</p>}
  </div>;
}
