import type { HistoryItem } from "../../../types";
import { CopyMessageButton, MessageTimestamp } from "./MessageActions";
import { presentTool } from "./tool-presentation";

export function ToolDetails({ item }: { item: HistoryItem }) {
  const presentation = presentTool(item);
  return <div className="tool-details-content">
    <div className="tool-detail-meta"><span>{presentation.stateLabel}</span><span>原始状态：{presentation.nativeStatus}</span></div>
    {item.title && <section className="tool-detail-section"><h3>{item.type === "commandExecution" || item.type === "shell" ? "命令" : "调用"}</h3><pre className="tool-detail-command"><code>{item.title}</code></pre></section>}
    <section className="tool-detail-section"><h3>输出</h3>
      {item.text ? <pre className="tool-detail-output" tabIndex={0}><code>{item.text}</code></pre>
        : presentation.isRunning ? <div className="tool-output-skeleton" role="status"><span className="sr-only">运行中，等待工具输出</span><i /><i /><i /></div>
        : <p className="tool-empty-output">没有记录工具输出</p>}
    </section>
    {item.truncated && <p className="tool-truncation-note" role="note">内容已裁剪，仅显示当前收到的内容</p>}
    <div className="tool-detail-footer">{item.timestamp && <MessageTimestamp timestamp={item.timestamp} />}{item.text && <CopyMessageButton text={item.text} label="复制工具输出" />}</div>
  </div>;
}
