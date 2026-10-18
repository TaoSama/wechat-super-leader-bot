import { useState } from "react";
import { COMMAND_STATUS_SEMANTICS, type CommandRecord } from "../../../types";
import { formatTimestamp } from "../../../format";
import { CommandOutput } from "./CommandOutput";

export function CommandDetails({ command }: { command: CommandRecord }) {
  const [expanded, setExpanded] = useState(false);
  return <details className="command-details" onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>指令详情与回执</summary>
    <div className="command-detail-content">
      <p>{COMMAND_STATUS_SEMANTICS[command.status].description}</p>
      <dl><div><dt>会话标识</dt><dd>{command.nodeId} / {command.sessionId}</dd></div><div><dt>指令 ID</dt><dd>{command.commandId}</dd></div><div><dt>请求 ID</dt><dd>{command.requestId}</dd></div></dl>
      {command.inputReceipt && <dl><div><dt>输入证明</dt><dd>{command.inputReceipt.kind}</dd></div><div><dt>证明会话</dt><dd>{command.inputReceipt.sessionId}</dd></div><div><dt>宿主请求 ID</dt><dd>{command.inputReceipt.requestId}</dd></div><div><dt>实际输入 SHA256</dt><dd>{command.inputReceipt.promptSHA256}</dd></div><div><dt>响应 / 观测版本</dt><dd>{command.inputReceipt.responseRevision} / {command.inputReceipt.observedRevision}</dd></div></dl>}
      {command.turnId && <p>关联 Turn: {command.turnId}（按该轮次核验，不以会话空闲状态判断完成）</p>}
      <p>创建: {formatTimestamp(command.createdAt)}</p><p>更新: {formatTimestamp(command.updatedAt)}</p><p>派发截止（非执行时限）: {formatTimestamp(command.expiresAt)}</p>
      {command.prompt && <div><h5>完整请求</h5><pre>{command.prompt}</pre></div>}
      <CommandOutput command={command} expanded={expanded} />
    </div>
  </details>;
}
