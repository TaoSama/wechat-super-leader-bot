/** Only operator configuration chooses destinations; task content never supplies an endpoint. */
export function validateFallbackEndpoint(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error("Invalid fallback webhook URL"); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname.toLowerCase());
  if (parsed.username || parsed.password || parsed.hash || /[\\\u0000-\u0020\u007f]/.test(value) ||
      !(parsed.protocol === "https:" || parsed.protocol === "http:" && loopback)) {
    throw new Error("Fallback webhook must use HTTPS (HTTP only for loopback), without userinfo or fragment");
  }
  return parsed.href;
}

export function parseFallbackEndpoints(raw?: string): ReadonlyMap<string, string> {
  if (!raw?.trim()) return new Map();
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("FALLBACK_WEBHOOKS must be a JSON object (value redacted)"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("FALLBACK_WEBHOOKS must map chat IDs to webhook URLs");
  const result = new Map<string, string>();
  for (const [chatId, endpoint] of Object.entries(parsed)) {
    if (!chatId.trim() || chatId.length > 128 || typeof endpoint !== "string") throw new Error("Invalid fallback webhook mapping");
    result.set(chatId, validateFallbackEndpoint(endpoint));
  }
  return result;
}
