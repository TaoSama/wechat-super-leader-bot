import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { formatClock, formatTimestamp } from "../../../format";

const COPY_FEEDBACK_MS = 2000;
const TIMESTAMP_REVEAL_MS = 3000;

export function CopyMessageButton({ text, label = "复制消息" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const copyAttemptRef = useRef(0);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  async function copy() {
    const attempt = ++copyAttemptRef.current;
    if (timerRef.current) clearTimeout(timerRef.current);
    setCopied(false);
    setFailed(false);
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(text);
      if (!mountedRef.current || attempt !== copyAttemptRef.current) return;
      setFailed(false);
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    } catch {
      if (!mountedRef.current || attempt !== copyAttemptRef.current) return;
      setCopied(false);
      setFailed(true);
    }
  }

  const Icon = copied ? Check : Copy;
  return <span className="message-copy-control">
    <button type="button" className="message-action" aria-label={copied ? "已复制" : label} title={copied ? "已复制" : label} onClick={() => void copy()}><Icon size={14} aria-hidden="true" /></button>
    <span className="sr-only" role="status">{copied ? "已复制" : ""}</span>
    {failed && <span className="message-copy-error" role="alert">复制失败，请选择文本后手动复制</span>}
  </span>;
}

export function MessageTimestamp({ timestamp }: { timestamp: string }) {
  const [revealed, setRevealed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fullTime = `${formatTimestamp(timestamp)} UTC+8`;
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  function reveal() {
    setRevealed(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setRevealed(false), TIMESTAMP_REVEAL_MS);
  }

  return <span className={`message-timestamp ${revealed ? "is-revealed" : ""}`}>
    <button type="button" className="message-time-button" aria-label={`查看完整时间：${fullTime}`} title={fullTime} onClick={reveal}><time dateTime={timestamp} title={fullTime}>{formatClock(timestamp)}</time></button>
    <span className="message-timestamp-detail" aria-hidden={!revealed}>{fullTime}</span>
  </span>;
}
