export const DISPLAY_TIME_ZONE = "Asia/Shanghai";
export const DISPLAY_TIME_GUIDANCE = "默认向用户展示北京时间（Asia/Shanghai，UTC+8），使用24小时制。" +
  "将已知ISO/UTC时间换算到北京时间，跨日时同步换算日期，不能仅替换时区标签；时间来源或时区不明时不得猜测。" +
  "用户明确指定其他时区时尊重该时区的时间和调度语义并标明时区，不改变实际触发时刻。原始日志、代码、引文与完整成果附件保留原文。";

const displayFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: DISPLAY_TIME_ZONE,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

/** Format an instant for user-facing prose without changing its persisted value. */
export function formatDisplayTime(timestamp: number): string {
  const parts = Object.fromEntries(displayFormatter.formatToParts(timestamp).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}（北京时间）`;
}
