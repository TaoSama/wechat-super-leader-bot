import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { HistoryItem } from "../../../types";
import { CopyMessageButton, MessageTimestamp } from "./MessageActions";
import { ToolMessage } from "./ToolMessage";

const ROLE_NAMES = { user: "你", assistant: "助手", tool: "工具", system: "系统" };

const Markdown = memo(function Markdown({ text }: { text: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
    img: ({ alt }) => <span className="image-placeholder">[图片未加载{alt ? `：${alt}` : ""}]</span>,
    a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{children}</a>,
  }}>{text}</ReactMarkdown>;
});

export const HistoryMessage = memo(function HistoryMessage({ item }: { item: HistoryItem }) {
  const transcriptChunk = item.type === "transcript_chunk";
  if (item.kind === "tool") return <ToolMessage item={item} />;
  return <article className={`history-message role-${item.kind}`} data-history-id={item.id}>
    {(transcriptChunk || item.kind === "system") && <div className="message-meta"><span>{transcriptChunk ? `${ROLE_NAMES[item.kind]} · 文本片段（非完整轮次）` : ROLE_NAMES[item.kind]}</span></div>}
    <div className="message-body">{item.kind === "user" ? <div className="user-message-text">{item.text}</div> : <div className="markdown"><Markdown text={item.text} /></div>}{item.truncated && <p className="muted">内容已裁剪</p>}</div>
    {(item.kind !== "system" || item.timestamp) && <div className="message-actions">{item.timestamp && <MessageTimestamp timestamp={item.timestamp} />}{item.kind !== "system" && item.text && <CopyMessageButton text={item.text} />}</div>}
  </article>;
});
