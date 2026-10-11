const HISTORY_CONTEXT_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i;

export const HISTORY_CONTEXT_EXPIRED_MESSAGE = "历史读取上下文已失效，已保留读取内容；请重新读取最新页。";

export function isHistoryContext(value: unknown): value is string {
  return typeof value === "string" && HISTORY_CONTEXT_PATTERN.test(value);
}
