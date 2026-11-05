import { useState } from "react";
import { ConfirmDialog } from "../../../components/ui/ConfirmDialog";
import { cancelGoal, cancelPlan, type AuthorizationReceipt } from "../../../api/authorizations";
import { useAuthorizationSubmit } from "../useAuthorizationSubmit";

interface Props { kind: "plan" | "goal"; id: string; onDone: (receipt: AuthorizationReceipt) => void }

const COPY = {
  plan: { button: "取消计划", title: "取消计划", confirm: "确认取消计划", description: "仅停止这个计划尚未派发的后续步骤；原会话已在执行的任务不会停止。" },
  goal: { button: "取消目标", title: "取消持续目标", confirm: "确认取消目标", description: "撤销这个目标的后续派发权；原会话当前动作不会停止，已受理的请求可能已经发送。" },
};

export function AuthorizationCancel({ kind, id, onDone }: Props) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const submit = useAuthorizationSubmit();
  const copy = COPY[kind];

  async function cancel() {
    const receipt = await submit.run((requestId, signal) => kind === "plan" ? cancelPlan(id, requestId, signal) : cancelGoal(id, requestId, signal));
    setConfirmOpen(false);
    if (receipt) onDone(receipt);
  }

  return <div className="command-queue-action">
    <button type="button" className="ui-button ghost" disabled={submit.busy} onClick={() => setConfirmOpen(true)}>{copy.button}</button>
    {confirmOpen && <ConfirmDialog title={copy.title} description={copy.description} confirmLabel={copy.confirm} busy={submit.busy} destructive
      onConfirm={() => void cancel()} onClose={() => setConfirmOpen(false)} />}
    {submit.error && <p role="alert" className="command-error">{submit.error}</p>}
  </div>;
}
