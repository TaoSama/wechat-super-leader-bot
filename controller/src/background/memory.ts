import { assertSameBackgroundCreation, backgroundSpecFingerprint } from "./retention.js";
import type { BackgroundRepository, BackgroundWorker } from "./contracts.js";

export class MemoryBackgroundRepository implements BackgroundRepository {
  private workers = new Map<string, BackgroundWorker>();
  async create(worker: BackgroundWorker): Promise<BackgroundWorker> {
    const prior = [...this.workers.values()].find(item => item.runId === worker.runId);
    if (prior) {
      assertSameBackgroundCreation(prior, worker);
      return structuredClone(prior);
    }
    worker = { ...worker, specFingerprint: backgroundSpecFingerprint(worker.spec) };
    this.workers.set(worker.id, structuredClone(worker));
    return structuredClone(worker);
  }
  async get(id: string): Promise<BackgroundWorker | null> { return structuredClone(this.workers.get(id) ?? null); }
  async getByRun(runId: string): Promise<BackgroundWorker | null> {
    return structuredClone([...this.workers.values()].find(item => item.runId === runId) ?? null);
  }
  async list(chatId: string, limit = 100): Promise<BackgroundWorker[]> {
    return [...this.workers.values()].filter(item => item.chatId === chatId).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit).map(item => structuredClone(item));
  }
  async listLive(limit = 100): Promise<BackgroundWorker[]> {
    return [...this.workers.values()].filter(item => item.phase !== "cleaned").sort((a, b) => a.updatedAt - b.updatedAt).slice(0, limit).map(item => structuredClone(item));
  }
  async update(id: string, mutate: (worker: BackgroundWorker) => void): Promise<BackgroundWorker | null> {
    const current = this.workers.get(id);
    if (!current) return null;
    const next = structuredClone(current);
    mutate(next);
    this.workers.set(id, next);
    return structuredClone(next);
  }
}
