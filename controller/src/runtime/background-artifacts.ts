import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Router } from "express";
import { z } from "zod";
import type { BackgroundInvocation, BackgroundRepository, BackgroundWorker } from "../background/contracts.js";
import type { WorkerArtifact } from "../background/worker/contracts.js";
import { writeJson } from "../background/worker/storage.js";

export const BACKGROUND_ARTIFACT_ROUTE = "/v1/background-artifacts";
export const BACKGROUND_ARTIFACT_RETENTION_MS = 7 * 24 * 60 * 60_000;
const MARKER = ".background-download.json";
const EXPORT_MANIFEST = "result.json";
const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAINTENANCE_BATCH_SIZE = 64;
const UUID = z.string().uuid();
const ArtifactSchema = z.object({ name: z.string().min(1).max(1024), path: z.string().min(1).max(8192),
  size: z.number().int().nonnegative().max(MAX_ARTIFACT_BYTES), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const ManifestSchema = z.object({ version: z.literal(1), workerId: UUID, invocationId: UUID,
  chatId: z.string().min(1).max(512), createdAt: z.number().int().positive(), expiresAt: z.number().int().positive(),
  artifacts: z.array(ArtifactSchema).min(1).max(32) }).strict();
type Manifest = z.infer<typeof ManifestSchema>;
export interface BackgroundArtifactsOptions {
  root: string; publicUrl: string; secret: string; repository: BackgroundRepository;
  allowed: () => ReadonlySet<string>; retentionMs?: number; now?: () => number; maintenanceBatchSize?: number;
}

function ordinary(file: string, maxBytes: number): Buffer {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) throw new Error("Artifact is not a bounded ordinary file");
    const data = fs.readFileSync(descriptor);
    if (data.length !== stat.size || data.length > maxBytes) throw new Error("Artifact changed during read");
    return data;
  } finally { fs.closeSync(descriptor); }
}
function metadata(file: string): unknown { return JSON.parse(ordinary(file, MAX_METADATA_BYTES).toString("utf8")); }
function exists(file: string): boolean {
  try { fs.lstatSync(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
function digest(data: Buffer): string { return createHash("sha256").update(data).digest("hex"); }

/** Export storage is distinct from the expiring worker workspace. URLs contain no local paths. */
export class BackgroundArtifacts {
  readonly root: string;
  private readonly origin: string;
  private readonly now: () => number;
  private readonly retentionMs: number;
  private readonly maintenanceBatchSize: number;
  private rootCursor?: fs.Dir;
  private workerCursor?: { workerId: string; directory: string; cursor: fs.Dir };
  private maintenancePromise?: Promise<{ removed: number }>;
  constructor(private readonly options: BackgroundArtifactsOptions) {
    const url = new URL(options.publicUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      throw new Error("Background artifact public URL must be an HTTP origin");
    }
    if (options.secret.length < 32) throw new Error("Background artifact signing secret requires at least 32 characters");
    if (!path.isAbsolute(options.root) || path.resolve(options.root) === path.parse(options.root).root || path.resolve(options.root) === homedir()) {
      throw new Error("A dedicated absolute artifact root is required");
    }
    fs.mkdirSync(options.root, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(options.root).isSymbolicLink() || !fs.lstatSync(options.root).isDirectory()) throw new Error("Unsafe artifact root");
    this.root = fs.realpathSync(options.root);
    this.origin = url.origin;
    this.now = options.now ?? Date.now;
    this.retentionMs = options.retentionMs ?? BACKGROUND_ARTIFACT_RETENTION_MS;
    if (!Number.isSafeInteger(this.retentionMs) || this.retentionMs <= 0) throw new Error("Invalid artifact retention");
    this.maintenanceBatchSize = options.maintenanceBatchSize ?? DEFAULT_MAINTENANCE_BATCH_SIZE;
    if (!Number.isSafeInteger(this.maintenanceBatchSize) || this.maintenanceBatchSize < 1 || this.maintenanceBatchSize > 1_000) throw new Error("Invalid artifact maintenance batch size");
  }
  private directory(workerId: string, invocationId: string): string {
    UUID.parse(workerId); UUID.parse(invocationId);
    for (const dir of [this.root, path.join(this.root, workerId), path.join(this.root, workerId, invocationId)]) {
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(dir) !== dir) throw new Error("Unsafe artifact directory");
    }
    return path.join(this.root, workerId, invocationId);
  }
  private checkArtifacts(dir: string, artifacts: WorkerArtifact[], readBytes = true): void {
    for (const [index, artifact] of artifacts.entries()) {
      ArtifactSchema.parse(artifact);
      if (path.basename(artifact.name) !== artifact.name || /[\\/\x00-\x1f\x7f]/.test(artifact.name)) throw new Error("Unsafe artifact name");
      if (artifact.path !== path.join(dir, `${index}-${artifact.name}`)) throw new Error("Artifact does not belong to its exact export");
      if (readBytes) {
        const data = ordinary(artifact.path, MAX_ARTIFACT_BYTES);
        if (data.length !== artifact.size || digest(data) !== artifact.sha256) throw new Error("Artifact integrity check failed");
      }
    }
  }
  private manifest(dir: string, workerId: string, invocationId: string): Manifest {
    const manifest = ManifestSchema.parse(metadata(path.join(dir, MARKER)));
    if (manifest.workerId !== workerId || manifest.invocationId !== invocationId || manifest.expiresAt <= manifest.createdAt) throw new Error("Artifact ownership marker mismatch");
    this.checkArtifacts(dir, manifest.artifacts, false);
    return manifest;
  }
  private signature(manifest: Manifest, index: number): Buffer {
    return createHmac("sha256", this.options.secret).update(JSON.stringify(["background-artifact-v1", manifest.chatId,
      manifest.workerId, manifest.invocationId, index, manifest.expiresAt, manifest.artifacts[index]])).digest();
  }
  async links(worker: BackgroundWorker, invocation: BackgroundInvocation, artifacts: WorkerArtifact[]): Promise<string[]> {
    const manifest = await this.prepareManifest(worker, invocation, artifacts, true);
    if (!manifest) return [];
    if (manifest.expiresAt <= this.now()) throw new Error("Artifact export has expired");
    return artifacts.map((_artifact, index) => `${this.origin}${BACKGROUND_ARTIFACT_ROUTE}/${worker.id}/${invocation.id}/${index}/download?expires=${manifest.expiresAt}&signature=${this.signature(manifest, index).toString("hex")}`);
  }
  /** Retain an ownership marker for safe expiry without granting or publishing access. */
  async retainDiscarded(worker: BackgroundWorker, invocation: BackgroundInvocation, artifacts: WorkerArtifact[]): Promise<void> {
    await this.prepareManifest(worker, invocation, artifacts, false);
  }
  private async prepareManifest(worker: BackgroundWorker, invocation: BackgroundInvocation, artifacts: WorkerArtifact[],
    grantAccess: boolean): Promise<Manifest | undefined> {
    const owned = await this.options.repository.get(worker.id);
    if (!owned || owned.chatId !== worker.chatId || owned.runId !== worker.runId ||
      (grantAccess && !this.options.allowed().has(owned.chatId))) throw new Error("Artifact worker is unavailable for this chat");
    if (!grantAccess && this.options.allowed().has(owned.chatId) && !owned.cancelRequestedAt) throw new Error("Discard retention requires revoked or cancelled work");
    const recorded = owned.invocations.find(item => item.id === invocation.id);
    if (!recorded || recorded.createdAt !== invocation.createdAt || recorded.kind !== invocation.kind) throw new Error("Artifact invocation ownership mismatch");
    if (!artifacts.length) return;
    if (artifacts.length > 32) throw new Error("Too many artifact exports");
    const dir = this.directory(worker.id, invocation.id);
    this.checkArtifacts(dir, artifacts);
    const exported = z.object({ workerId: UUID, invocationId: UUID, artifacts: z.array(ArtifactSchema).max(32) }).passthrough().parse(metadata(path.join(dir, EXPORT_MANIFEST)));
    if (exported.workerId !== worker.id || exported.invocationId !== invocation.id || !isDeepStrictEqual(exported.artifacts, artifacts)) throw new Error("Artifact list does not match runtime export receipt");
    const marker = path.join(dir, MARKER);
    let manifest: Manifest;
    if (exists(marker)) manifest = this.manifest(dir, worker.id, invocation.id);
    else {
      manifest = { version: 1, workerId: worker.id, invocationId: invocation.id, chatId: owned.chatId,
        createdAt: this.now(), expiresAt: this.now() + this.retentionMs, artifacts };
      writeJson(marker, manifest);
    }
    if (manifest.chatId !== owned.chatId || !isDeepStrictEqual(manifest.artifacts, artifacts)) throw new Error("Artifact immutable manifest mismatch");
    return manifest;
  }
  router(): Router {
    const router = Router();
    router.get("/:workerId/:invocationId/:index/download", async (req, res) => {
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("X-Content-Type-Options", "nosniff");
      const { workerId, invocationId, index: rawIndex } = req.params;
      if (!UUID.safeParse(workerId).success || !UUID.safeParse(invocationId).success || !/^(?:0|[1-9]\d?)$/.test(rawIndex)
        || typeof req.query.expires !== "string" || !/^\d{1,16}$/.test(req.query.expires)
        || typeof req.query.signature !== "string" || !/^[a-f0-9]{64}$/.test(req.query.signature)) {
        res.status(403).json({ error: "Invalid artifact download authorization" }); return;
      }
      // Verify authoritative ownership before opening anything in artifact storage.
      let worker: BackgroundWorker | null;
      try { worker = await this.options.repository.get(workerId); }
      catch { res.status(503).json({ error: "Artifact ownership is temporarily unavailable" }); return; }
      const invocation = worker?.invocations.find(item => item.id === invocationId);
      if (!worker || !this.options.allowed().has(worker.chatId) || !invocation?.exported || !invocation.receipt?.artifacts) {
        res.status(404).json({ error: "Artifact not found" }); return;
      }
      try {
        const dir = this.directory(workerId, invocationId);
        const manifest = this.manifest(dir, workerId, invocationId);
        const index = Number(rawIndex);
        if (manifest.chatId !== worker.chatId || !isDeepStrictEqual(manifest.artifacts, invocation.receipt.artifacts)) {
          res.status(404).json({ error: "Artifact not found" }); return;
        }
        if (!manifest.artifacts[index] || String(manifest.expiresAt) !== req.query.expires
          || !timingSafeEqual(this.signature(manifest, index), Buffer.from(req.query.signature, "hex"))) {
          res.status(403).json({ error: "Invalid artifact download authorization" }); return;
        }
        if (manifest.expiresAt <= this.now()) { res.status(410).json({ error: "Artifact expired" }); return; }
        const artifact = manifest.artifacts[index];
        const data = ordinary(artifact.path, MAX_ARTIFACT_BYTES);
        if (data.length !== artifact.size || digest(data) !== artifact.sha256) throw new Error("Artifact integrity check failed");
        res.attachment(artifact.name);
        res.type("application/octet-stream");
        res.setHeader("Content-Length", data.length);
        res.send(data);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") res.status(404).json({ error: "Artifact not found" });
        else res.status(409).json({ error: "Artifact is unavailable or failed integrity verification" });
      }
    });
    return router;
  }
  /** Close directory cursors during orderly application shutdown. */
  async close(): Promise<void> {
    try { await this.maintenancePromise; }
    finally {
      this.workerCursor?.cursor.closeSync(); this.workerCursor = undefined;
      this.rootCursor?.closeSync(); this.rootCursor = undefined;
    }
  }
  /** Bounded scan of marked exports accepted by the outbox or explicitly discarded by the user. */
  maintenance(): Promise<{ removed: number }> {
    return this.maintenancePromise ??= this.scan().finally(() => { this.maintenancePromise = undefined; });
  }
  private async scan(): Promise<{ removed: number }> {
    let removed = 0;
    const workers = new Map<string, BackgroundWorker | null>();
    if (fs.lstatSync(this.root).isSymbolicLink() || fs.realpathSync(this.root) !== this.root) throw new Error("Unsafe artifact root");
    this.rootCursor ??= fs.opendirSync(this.root);
    for (let inspected = 0; inspected < this.maintenanceBatchSize; inspected++) {
      if (!this.workerCursor) {
        const entry = this.rootCursor.readSync();
        if (!entry) { this.rootCursor.closeSync(); this.rootCursor = undefined; break; }
        if (!UUID.safeParse(entry.name).success || !entry.isDirectory() || entry.isSymbolicLink()) continue;
        const directory = path.join(this.root, entry.name);
        if (!exists(directory)) continue;
        if (fs.realpathSync(directory) !== directory) throw new Error("Unsafe artifact worker directory");
        this.workerCursor = { workerId: entry.name, directory, cursor: fs.opendirSync(directory) };
      }
      const current = this.workerCursor;
      if (!workers.has(current.workerId)) workers.set(current.workerId, await this.options.repository.get(current.workerId));
      const worker = workers.get(current.workerId);
      const entry = worker ? current.cursor.readSync() : null;
      if (!entry) {
        current.cursor.closeSync(); this.workerCursor = undefined;
        // UUID plus repository ownership is required even for removal of an empty parent.
        if (worker && exists(current.directory) && fs.realpathSync(current.directory) === current.directory && fs.readdirSync(current.directory).length === 0) {
          try { fs.rmdirSync(current.directory); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY" && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
        continue;
      }
      if (!UUID.safeParse(entry.name).success || !entry.isDirectory() || entry.isSymbolicLink()) continue;
      const invocation = worker!.invocations.find(item => item.id === entry.name);
      if (!invocation || (!invocation.acceptedAt && !invocation.discardedAt) || !invocation.exported || worker!.activeInvocationId === entry.name) continue;
      const dir = this.directory(current.workerId, entry.name);
      if (!exists(path.join(dir, MARKER))) continue;
      const manifest = this.manifest(dir, current.workerId, entry.name);
      if (manifest.expiresAt > this.now() || manifest.chatId !== worker!.chatId
        || !isDeepStrictEqual(manifest.artifacts, invocation.receipt?.artifacts)) continue;
      const expected = new Set([MARKER, EXPORT_MANIFEST, ...manifest.artifacts.map(item => path.basename(item.path))]);
      const files = fs.readdirSync(dir);
      if (files.some(file => !expected.has(file))) continue;
      // Validate all entries first; never recursively traverse unrecognized files or links.
      for (const file of files) {
        const item = fs.lstatSync(path.join(dir, file));
        if (!item.isFile() || item.isSymbolicLink() || item.nlink !== 1) throw new Error("Unsafe expired artifact export");
      }
      // Keep the ownership marker until last so interrupted cleanup can resume safely.
      for (const file of files.filter(file => file !== MARKER)) fs.unlinkSync(path.join(dir, file));
      fs.unlinkSync(path.join(dir, MARKER));
      fs.rmdirSync(dir);
      removed++;
    }
    return { removed };
  }
}
