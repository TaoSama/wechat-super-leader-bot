import { useEffect, useRef, useState } from "react";
import { ApiAuthError } from "../../../api/errors";
import { fetchCommand } from "../../../api/sessions";
import { setUnauthenticatedSession } from "../../../auth/bootstrap";
import type { CommandRecord } from "../../../types";

interface OutputState { output?: string; loading: boolean; error?: string; cancelled?: boolean }
const EMPTY: OutputState = { loading: false };

export function CommandOutput({ command, expanded }: { command: CommandRecord; expanded: boolean }) {
  const [state, setState] = useState<OutputState>(EMPTY);
  const [attempt, setAttempt] = useState(0);
  const active = useRef<AbortController | null>(null);
  const terminal = command.sendRoute === "terminal-pane";

  useEffect(() => {
    if (!expanded) { setState(EMPTY); return; }
    if (terminal || command.output !== undefined || !command.hasOutput) return;
    const controller = new AbortController();
    active.current = controller;
    setState({ loading: true });
    void fetchCommand(command.commandId, controller.signal).then(receipt => {
      if (controller.signal.aborted) return;
      if (receipt.nodeId !== command.nodeId || receipt.sessionId !== command.sessionId || receipt.action !== command.action ||
          receipt.output === undefined) throw new Error("完整结果回执与当前指令不匹配");
      setState({ output: receipt.output, loading: false });
    }).catch(cause => {
      if (controller.signal.aborted) return;
      if (cause instanceof ApiAuthError) { setUnauthenticatedSession("expired"); return; }
      setState({ loading: false, error: "完整结果加载失败，可重试；摘要不代表完整结果。" });
    }).finally(() => { if (active.current === controller) active.current = null; });
    return () => { controller.abort(); if (active.current === controller) active.current = null; };
  }, [expanded, command.commandId, command.nodeId, command.sessionId, command.action, command.updatedAt, command.output, command.hasOutput, terminal, attempt]);

  if (terminal || command.output === undefined && !command.hasOutput) return null;
  const output = command.output ?? state.output;
  return <div className="command-output">
    <h5>最终回执 / 返回快照</h5>
    {output !== undefined ? output ? <pre>{output}</pre> : <p>结果为空。</p> : <>
      <p>完整结果已保存，展开时按需读取。{command.outputTruncated ? "以下仅为摘要。" : ""}</p>
      {command.outputPreview && <pre aria-label="结果摘要">{command.outputPreview}</pre>}
      {state.loading ? <><p role="status">正在加载完整结果…</p><button type="button" className="ui-button ghost" onClick={() => {
        active.current?.abort(); active.current = null; setState({ loading: false, cancelled: true });
      }}>取消加载</button></> : <button type="button" className="ui-button ghost" onClick={() => setAttempt(value => value + 1)}>{state.error ? "重试加载完整结果" : "加载完整结果"}</button>}
      {state.cancelled && <p role="status">加载已取消，完整结果仍可按需读取。</p>}
      {state.error && <p role="alert" className="command-error">{state.error}</p>}
    </>}
  </div>;
}
