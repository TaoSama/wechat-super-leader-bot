export type DeliveryStatus = "preparing" | "ready" | "claimed" | "waiting_for_user" | "accepted" | "uncertain" | "superseded";
export interface ConsoleDelivery {
  id: string;
  kind: string;
  status: DeliveryStatus;
  mode: "text" | "attachment" | "download";
  messages: string[];
  artifact: { id: string; name: string; size: number; expiresAt: number };
  createdAt: number;
  expiresAt: number;
  retainedUntil: number;
}
const STATUSES = new Set(["preparing", "ready", "claimed", "waiting_for_user", "accepted", "uncertain", "superseded"]);
const MODES = new Set(["text", "attachment", "download"]);
const MAX_DATE_MS = 8_640_000_000_000_000;
const date = (raw: unknown): raw is number => typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 && raw <= MAX_DATE_MS;

export function parseDelivery(raw: unknown): ConsoleDelivery {
  const fail = (): never => { throw new Error("成果交付状态格式无效"); };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail();
  const item = raw as Record<string, unknown>;
  if (typeof item.id !== "string" || !item.id.trim() || typeof item.kind !== "string" || !item.kind.trim() ||
      !STATUSES.has(String(item.status)) || !MODES.has(String(item.mode)) || !Array.isArray(item.messages) ||
      !item.messages.every(message => typeof message === "string") || !date(item.createdAt) || !date(item.expiresAt) || !date(item.retainedUntil) ||
      !item.artifact || typeof item.artifact !== "object" || Array.isArray(item.artifact)) return fail();
  const artifact = item.artifact as Record<string, unknown>;
  if (typeof artifact.id !== "string" || !artifact.id.trim() || typeof artifact.name !== "string" || !artifact.name.trim() ||
      typeof artifact.size !== "number" || !Number.isSafeInteger(artifact.size) || artifact.size < 0 || !date(artifact.expiresAt)) return fail();
  return { id: item.id, kind: item.kind, status: item.status as DeliveryStatus, mode: item.mode as ConsoleDelivery["mode"],
    messages: item.messages as string[], artifact: { id: artifact.id, name: artifact.name, size: artifact.size, expiresAt: artifact.expiresAt },
    createdAt: item.createdAt, expiresAt: item.expiresAt, retainedUntil: item.retainedUntil };
}

export function parseDeliveries(raw: unknown): ConsoleDelivery[] {
  if (raw === undefined) return [];
  if (Array.isArray(raw)) return raw.map(parseDelivery);
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as Record<string, unknown>).items)) throw new Error("成果交付列表格式无效");
  return ((raw as { items: unknown[] }).items).map(parseDelivery);
}
