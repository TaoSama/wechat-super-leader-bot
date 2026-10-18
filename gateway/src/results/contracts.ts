export const RESULT_TEXT_CHARS = 3800;
export const RESULT_TEXT_MESSAGES = 3;
export const RESULT_FILE_BYTES = 50 * 1024 * 1024;
export const RESULT_RESPONSE_BYTES = 2 * 1024 * 1024;
export const RESULT_TIMEOUT_MS = 15_000;
export const RESULT_PENDING_LIMIT = 128;
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const HASH = /^[a-f\d]{64}$/;

export interface ResultArtifact {
  id: string; chatId: string; name: string; size: number; sha256: string; expiresAt: number; downloadUrl?: string;
}
export interface ResultDelivery {
  id: string; key: string; chatId: string; source: { type: string; id: string }; kind: string;
  status: "preparing" | "ready" | "claimed" | "waiting_for_user" | "accepted" | "uncertain" | "superseded";
  mode: "text" | "attachment" | "download"; messages: string[]; artifact: ResultArtifact;
  createdAt: number; expiresAt: number; retainedUntil: number;
  business?: { category?: string; supersedes?: string };
  attemptId?: string; attemptedAt?: number; attemptExpiresAt?: number; deferReason?: string; error?: string; submittedMessages?: number;
  lastDeferredAttemptId?: string; lastDeferReason?: string; lastDeferredAt?: number;
}
export interface MaterializedResultDelivery extends ResultDelivery { artifact: ResultArtifact & { downloadUrl: string } }
export function resultObject(raw: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(key => !fields.includes(key))) return invalid();
  return raw as Record<string, unknown>;
}
export function resultUuid(raw: unknown): string { return typeof raw === "string" && UUID.test(raw) ? raw : invalid(); }
function invalid(): never { throw new Error("Controller result delivery response schema invalid"); }
function text(raw: unknown, max = 512): string {
  return typeof raw === "string" && raw.trim().length > 0 && raw.length <= max ? raw : invalid();
}
function time(raw: unknown): number {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 && raw <= 8_640_000_000_000_000 ? raw : invalid();
}
export function parseResultDelivery(raw: unknown, materialized = false): ResultDelivery {
  const value = resultObject(raw, ["id", "key", "chatId", "source", "kind", "status", "mode", "messages", "artifact", "createdAt", "expiresAt", "retainedUntil",
    "business", "attemptId", "attemptedAt", "attemptExpiresAt", "deferReason", "error", "submittedMessages", "lastDeferredAttemptId", "lastDeferReason", "lastDeferredAt"]);
  const id = resultUuid(value.id), key = text(value.key), chatId = text(value.chatId);
  const source = resultObject(value.source, ["type", "id"]);
  const kind = text(value.kind), status = value.status as ResultDelivery["status"], mode = value.mode as ResultDelivery["mode"];
  if (!["preparing", "ready", "claimed", "waiting_for_user", "accepted", "uncertain", "superseded"].includes(status) || !["text", "attachment", "download"].includes(mode) ||
    !Array.isArray(value.messages) || value.messages.length > (mode === "text" ? RESULT_TEXT_MESSAGES : mode === "attachment" ? 1 : 2) ||
    value.messages.some(item => typeof item !== "string" || !item.length || item.length > RESULT_TEXT_CHARS) ||
    status !== "preparing" && value.messages.length === 0 || materialized && mode === "download" && value.messages.length !== 2) return invalid();
  const artifact = resultObject(value.artifact, ["id", "chatId", "name", "size", "sha256", "expiresAt", "downloadUrl"]);
  const artifactId = resultUuid(artifact.id), artifactChat = text(artifact.chatId), name = text(artifact.name, 255);
  if (artifactChat !== chatId || /[\r\n\0/\\]/.test(name) || [".", ".."].includes(name) ||
    typeof artifact.size !== "number" || !Number.isSafeInteger(artifact.size) || artifact.size < 1 ||
    typeof artifact.sha256 !== "string" || !HASH.test(artifact.sha256) || materialized && typeof artifact.downloadUrl !== "string") return invalid();
  const createdAt = time(value.createdAt), expiresAt = time(value.expiresAt), retainedUntil = time(value.retainedUntil), artifactExpiresAt = time(artifact.expiresAt);
  if (expiresAt <= createdAt || retainedUntil < expiresAt || artifactExpiresAt !== retainedUntil) return invalid();
  const result: ResultDelivery = { id, key, chatId, source: { type: text(source.type), id: text(source.id) }, kind, status, mode,
    messages: value.messages as string[], artifact: { id: artifactId, chatId: artifactChat, name, size: artifact.size, sha256: artifact.sha256, expiresAt: artifactExpiresAt },
    createdAt, expiresAt, retainedUntil };
  if (artifact.downloadUrl !== undefined) result.artifact.downloadUrl = text(artifact.downloadUrl, 4096);
  if (value.business !== undefined) {
    const business = resultObject(value.business, ["category", "supersedes"]);
    result.business = { ...(business.category === undefined ? {} : { category: text(business.category) }),
      ...(business.supersedes === undefined ? {} : { supersedes: text(business.supersedes) }) };
  }
  if (value.attemptId !== undefined || value.attemptedAt !== undefined || value.attemptExpiresAt !== undefined) {
    result.attemptId = resultUuid(value.attemptId); result.attemptedAt = time(value.attemptedAt); result.attemptExpiresAt = time(value.attemptExpiresAt);
    if (result.attemptedAt < createdAt || result.attemptExpiresAt <= result.attemptedAt) return invalid();
  }
  if (["claimed", "accepted", "uncertain"].includes(status) ? !result.attemptId : result.attemptId !== undefined) return invalid();
  if (value.deferReason !== undefined) result.deferReason = text(value.deferReason);
  if (value.error !== undefined) result.error = text(value.error);
  if (value.lastDeferredAttemptId !== undefined || value.lastDeferReason !== undefined || value.lastDeferredAt !== undefined) {
    result.lastDeferredAttemptId = resultUuid(value.lastDeferredAttemptId);
    result.lastDeferReason = text(value.lastDeferReason, 128);
    result.lastDeferredAt = time(value.lastDeferredAt);
  }
  if (value.submittedMessages !== undefined) {
    if (typeof value.submittedMessages !== "number" || !Number.isSafeInteger(value.submittedMessages) || value.submittedMessages < 0) return invalid();
    result.submittedMessages = value.submittedMessages;
  }
  return result;
}
