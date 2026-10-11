export function formatTimestamp(iso: string): string {
  if (!iso || iso.trim() === "") {
    return "--";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

export function projectName(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || "项目未报告";
}

export function formatTimeShort(date: Date | null): string {
  if (!date || Number.isNaN(date.getTime())) {
    return "--:--:--";
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(
    date.getSeconds()
  )}`;
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
