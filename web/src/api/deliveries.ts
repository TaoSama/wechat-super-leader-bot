import { sessionRequest } from "./request";

export async function fetchFullDelivery(id: string, signal?: AbortSignal): Promise<string> {
  const content = await sessionRequest(`/v1/deliveries/${encodeURIComponent(id)}/full`, {
    method: "GET", headers: { Accept: "text/markdown" }, signal,
  }, false, "text");
  if (typeof content !== "string") throw new Error("完整成果格式无效");
  return content;
}
