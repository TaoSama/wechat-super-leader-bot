import { memo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { HistoryItem } from "../../../types";

const ROLE_NAMES = { user: "你", assistant: "助手", tool: "工具", system: "系统" };

const Markdown = memo(function Markdown({ text }: { text: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
    img: ({ alt }) => <span className="image-placeholder">[图片未加载{alt ? `：${alt}` : ""}]</span>,
    a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{children}</a>,
  }}>{text}</ReactMarkdown>;
});

export const HistoryMessage = memo(function HistoryMessage({ item }: { item: HistoryItem }) {
  const [expanded, setExpanded] = useState(false);
  const transcriptChunk = item.type === "transcript_chunk";
  if (item.kind === "tool") return <details className="tool-message" data-history-id={item.id} onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary><span>工具 · {item.title || item.type}</span><span className="muted">{item.status || "查看详情"}</span></summary>
    {expanded && <div className="markdown"><Markdown text={item.text} />{item.truncated && <p className="muted">内容已裁剪</p>}</div>}
  </details>;
  return <article className={`history-message role-${item.kind}`} data-history-id={item.id}>
    <div className="message-meta"><span>{transcriptChunk ? `${ROLE_NAMES[item.kind]} · 文本片段（非完整轮次）` : ROLE_NAMES[item.kind]}</span>{item.timestamp && <time dateTime={item.timestamp}>{new Date(item.timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time>}</div>
    <div className="markdown"><Markdown text={item.text} /></div>
    {item.truncated && <p className="muted">内容已裁剪</p>}
  </article>;
});
