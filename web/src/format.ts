export const DISPLAY_TIME_ZONE = "Asia/Shanghai";

const clockFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: DISPLAY_TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const timestampFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: DISPLAY_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

export function formatClock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "--:--" : clockFormatter.format(date);
}

export function formatTimestamp(iso: string): string {
  if (!iso || iso.trim() === "") {
    return "--";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const parts = Object.fromEntries(timestampFormatter.formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

export function projectName(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || "项目未报告";
}

export function formatTimeShort(date: Date | null): string {
  if (!date || Number.isNaN(date.getTime())) {
    return "--:--:--";
  }
  return formatTimestamp(date.toISOString()).split(" ")[1];
}

export function formatRelativeAge(iso: string, nowMs: number = Date.now()): string {
  if (!iso || iso.trim() === "") {
    return "无记录";
  }
  const parsed = new Date(iso).getTime();
  if (Number.isNaN(parsed)) {
    return iso;
  }
  const diffSec = Math.max(0, Math.floor((nowMs - parsed) / 1000));
  if (diffSec < 5) {
    return "刚刚";
  }
  if (diffSec < 60) {
    return `${diffSec} 秒前`;
  }
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) {
    return `${diffMin} 分钟前`;
  }
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) {
    return `${diffHour} 小时前`;
  }
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay} 天前`;
}
