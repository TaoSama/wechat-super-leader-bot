import type { ResultInput } from "../deliveries/contracts.js";
import type { ResultDeliveryService } from "../deliveries/service.js";
import type { IStore } from "../store/interface.js";
import { normalizeNotification, validateNotificationTime, type StoredNotification } from "./contracts.js";

export const TERMINAL_RESULT_TTL_MS = 7 * 24 * 60 * 60_000;
export const PROGRESS_RESULT_TTL_MS = 5 * 60_000;
export const RESULT_COLLECTOR_BATCH_SIZE = 8;

type CandidateStore = Pick<IStore, "listNotificationCandidates" | "getNotificationParts" | "markNotificationPrepared">;
type ResultSink = Pick<ResultDeliveryService, "prepareResult" | "repository">;
export interface CollectionReport {
  scanned: number;
  prepared: number;
  existing: number;
  failures: { id: string; error: string }[];
}

/** The immutable terminal outbox, rather than live commands, is the result authority. */
export function notificationResultInput(first: StoredNotification, parts: readonly StoredNotification[]): ResultInput {
  const notification = normalizeNotification(first);
  if (notification.kind === "progress") return {
    id: notification.id, key: `notification:progress:${notification.id}`, chatId: notification.chatId,
    source: notification.source, kind: notification.kind, text: notification.text,
    createdAt: notification.createdAt, expiresAt: notification.createdAt + PROGRESS_RESULT_TTL_MS,
    business: { category: "progress", supersedes: `notification:${notification.source.type}:${notification.source.id}:progress` },
  };
  if ((notification.part?.index ?? 1) !== 1) throw new Error("Terminal result must start at its first part");
  const total = notification.part?.total ?? 1;
  const ordered = parts.map(normalizeNotification).sort((a, b) =>
    (a.kind === "progress" ? 0 : a.part?.index ?? 1) - (b.kind === "progress" ? 0 : b.part?.index ?? 1));
  if (ordered.length !== total || ordered.some((item, index) => item.kind === "progress" ||
    item.source.type !== notification.source.type || item.source.id !== notification.source.id ||
    item.chatId !== notification.chatId || item.kind !== notification.kind || item.createdAt !== notification.createdAt ||
    (item.part?.total ?? 1) !== total || (item.part?.index ?? 1) !== index + 1) ||
    ordered[0]?.id !== notification.id || ordered[0]?.text !== notification.text)
    throw new Error("Terminal notification parts are missing, duplicated, or inconsistent");
  return { id: notification.id, key: `notification:${notification.source.type}:${notification.source.id}`,
    chatId: notification.chatId, source: notification.source, kind: notification.kind,
    text: ordered.map(item => item.text).join(""), createdAt: notification.createdAt,
    expiresAt: notification.createdAt + TERMINAL_RESULT_TTL_MS };
}

/** Bounded round-robin scans revisit failed items without starving later UUIDs. */
export class NotificationResultCollector {
  private afterId = "";
  private active?: Promise<CollectionReport>;
  constructor(private readonly store: CandidateStore, private readonly results: ResultSink,
    private readonly batchSize = RESULT_COLLECTOR_BATCH_SIZE) {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 64) throw new Error("Invalid result collector batch size");
  }
  collect(chatIds: readonly string[], now = Date.now()): Promise<CollectionReport> {
    validateNotificationTime(now);
    if (this.active) return this.active;
    const running = this.collectBatch(chatIds, now);
    this.active = running;
    const release = () => { if (this.active === running) this.active = undefined; };
    void running.then(release, release);
    return running;
  }
  private async collectBatch(chatIds: readonly string[], now: number): Promise<CollectionReport> {
    const candidates = await this.store.listNotificationCandidates(chatIds, now, this.afterId, this.batchSize);
    const report: CollectionReport = { scanned: candidates.length, prepared: 0, existing: 0, failures: [] };
    for (const candidate of candidates) {
      try {
        const key = candidate.kind === "progress" ? `notification:progress:${candidate.id}` :
          `notification:${candidate.source.type}:${candidate.source.id}`;
        const existing = await this.results.repository.getByKey(key);
        if (existing) {
          await this.store.markNotificationPrepared(candidate.id, existing.id);
          report.existing++;
          continue;
        }
        const parts = candidate.kind === "progress" ? [] : await this.store.getNotificationParts(candidate.source);
        const result = await this.results.prepareResult(notificationResultInput(candidate, parts));
        await this.store.markNotificationPrepared(candidate.id, result.id);
        report.prepared++;
      } catch (error) {
        // Do not persist a handled marker: the next scan cycle retries this source.
        report.failures.push({ id: candidate.id, error: error instanceof Error ? error.message : "Result collection failed" });
      }
    }
    this.afterId = candidates.length === this.batchSize ? candidates[candidates.length - 1].id : "";
    return report;
  }
}
