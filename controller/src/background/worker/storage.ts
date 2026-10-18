import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { WorkerInput, WorkerRuntimeStatus } from "./contracts.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_CAPACITY_RECOVERY_GENERATIONS = 64;
export interface Receipt extends WorkerRuntimeStatus {
  inputHash: string;
  ownerPid: number;
  processPid?: number;
  exported?: boolean;
  exportedToCaller?: boolean;
  processCleanupUnverified?: boolean;
  queuedAt?: number;
  pendingInput?: WorkerInput;
}
interface WorkerState { workerId: string; threadId?: string }
interface LaunchClaim { ownerPid: number; decision?: "launch" | "cancel" }
const receiptSchema = z.object({
  workerId: z.string().regex(UUID), invocationId: z.string().regex(UUID),
  inputHash: z.string(), ownerPid: z.number().int().positive(),
  processPid: z.number().int().positive().optional(),
  status: z.enum(["queued", "running", "completed", "waiting", "needs_attention", "failed", "unknown"]),
  summary: z.string(), attachments: z.array(z.string()),
  queuedAt: z.number().int().nonnegative().optional(),
  pendingInput: z.object({ workerId: z.string().regex(UUID), invocationId: z.string().regex(UUID),
    task: z.string().trim().min(1), input: z.unknown() }).passthrough().optional(),
}).passthrough();

export function validId(id: string): void {
  if (!UUID.test(id)) throw new Error("Worker and invocation IDs must be UUIDs");
}
export function hash(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
export function alive(pid?: number): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}
export function readJson<T>(file: string): T | undefined {
  try {
    if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error("Unsafe runtime metadata");
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
function temporaryJson(file: string, value: unknown): string {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  return temporary;
}
export function writeJson(file: string, value: unknown): void {
  const temporary = temporaryJson(file, value);
  fs.renameSync(temporary, file);
  const directory = fs.openSync(path.dirname(file), "r");
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}
function claimJson(file: string, value: unknown): boolean {
  const temporary = temporaryJson(file, value);
  try {
    // A complete, fsynced inode is published atomically. Readers can never see
    // an empty slot/launch marker if the claimant exits during initialization.
    fs.linkSync(temporary, file);
    const directory = fs.openSync(path.dirname(file), "r");
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally { fs.unlinkSync(temporary); }
}
function directory(file: string, create = true): string {
  if (create) fs.mkdirSync(file, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(file).isSymbolicLink() || !fs.lstatSync(file).isDirectory()) throw new Error("Unsafe runtime directory");
  return fs.realpathSync(file);
}

/** Append-only claim chains avoid deleting a lock another reaper just acquired.
 * Claims are atomic symlinks (never followed); crashed owners can be succeeded.
 */
function claimReaper(slot: string, token: string): (() => void) | undefined {
  let file = path.join(path.dirname(slot), `reap-${hash(`${slot}:${token}`)}.lock`);
  for (let generation = 0; generation < MAX_CAPACITY_RECOVERY_GENERATIONS; generation++) {
    const id = randomUUID();
    try {
      fs.symlinkSync(`${process.pid}:${id}:held`, file);
      const ownedFile = file;
      return () => {
        const temporary = `${ownedFile}.${randomUUID()}.tmp`;
        fs.symlinkSync(`${process.pid}:${id}:done`, temporary);
        fs.renameSync(temporary, ownedFile);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const [ownerPid, ownerId, phase] = fs.readlinkSync(file).split(":");
      if (!ownerId || !["held", "done"].includes(phase)) throw new Error("Invalid capacity recovery claim");
      if (phase === "held" && alive(Number(ownerPid))) return undefined;
      file = path.join(path.dirname(slot), `reap-${hash(`${file}:${ownerId}`)}.lock`);
    }
  }
  throw new Error("Worker capacity recovery requires reconciliation");
}

export class WorkerStorage {
  readonly root: string;
  readonly artifacts: string;
  constructor(root: string, artifactRoot: string) {
    for (const candidate of [root, artifactRoot]) {
      if (!path.isAbsolute(candidate) || path.resolve(candidate) === path.parse(candidate).root || path.resolve(candidate) === homedir()) {
        throw new Error("Dedicated absolute worker and artifact roots are required");
      }
    }
    this.root = directory(root);
    this.artifacts = directory(artifactRoot);
    if (this.root === this.artifacts || this.root.startsWith(this.artifacts + path.sep) || this.artifacts.startsWith(this.root + path.sep)) {
      throw new Error("Artifact storage must survive worker cleanup");
    }
    directory(path.join(this.root, "workers"));
    directory(path.join(this.root, "tombstones"));
    directory(path.join(this.root, "slots"));
  }
  worker(workerId: string, create = false): string | undefined {
    validId(workerId);
    if (this.removed(workerId)) {
      if (create) throw new Error("Worker has been cleaned up");
      return undefined;
    }
    const dir = path.join(this.root, "workers", workerId);
    if (!create) {
      try { fs.lstatSync(dir); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    }
    if (directory(dir, create) !== dir) throw new Error("Worker path must not contain symlinks");
    const state = this.state(dir);
    if (!state) {
      if (!create) throw new Error("Missing worker ownership marker");
      writeJson(path.join(dir, "state.json"), { workerId });
    } else if (state.workerId !== workerId) throw new Error("Invalid worker ownership marker");
    for (const subdir of ["workspace", "home", "invocations"]) {
      if (directory(path.join(dir, subdir), create && !state) !== path.join(dir, subdir)) throw new Error("Unsafe worker directory");
    }
    return dir;
  }
  removed(workerId: string): boolean {
    validId(workerId);
    return !!readJson(path.join(this.root, "tombstones", `${workerId}.json`));
  }
  state(dir: string): WorkerState | undefined { return readJson<WorkerState>(path.join(dir, "state.json")); }
  setThread(dir: string, threadId: string): void {
    validId(threadId);
    const state = this.state(dir)!;
    if (state.threadId && state.threadId !== threadId) throw new Error("Codex changed worker thread identity");
    writeJson(path.join(dir, "state.json"), { ...state, threadId });
  }
  receiptPath(dir: string, invocationId: string): string {
    validId(invocationId); return path.join(dir, "invocations", `${invocationId}.json`);
  }
  receipt(dir: string, invocationId: string): Receipt | undefined {
    const value = readJson<Receipt>(this.receiptPath(dir, invocationId));
    if (value === undefined) return undefined;
    const parsed = receiptSchema.safeParse(value);
    if (!parsed.success || value.workerId !== path.basename(dir) || value.invocationId !== invocationId) {
      throw new Error("Invalid worker receipt metadata");
    }
    if (value.status === "queued" && (!value.pendingInput || value.pendingInput.workerId !== value.workerId ||
      value.pendingInput.invocationId !== invocationId || hash(JSON.stringify(value.pendingInput)) !== value.inputHash)) {
      throw new Error("Invalid queued worker input metadata");
    }
    return value;
  }
  save(dir: string, receipt: Receipt): void { writeJson(this.receiptPath(dir, receipt.invocationId), receipt); }
  claim(dir: string, invocationId: string): void {
    if (!claimJson(path.join(dir, "active.json"), { invocationId })) throw new Error("Worker already has active ownership");
  }
  launchClaim(dir: string, invocationId: string): LaunchClaim | undefined {
    validId(invocationId);
    return readJson<LaunchClaim>(path.join(dir, "invocations", `${invocationId}.launch`));
  }
  claimLaunch(dir: string, invocationId: string, decision: "launch" | "cancel" = "launch"): boolean {
    validId(invocationId);
    return claimJson(path.join(dir, "invocations", `${invocationId}.launch`), { ownerPid: process.pid, decision });
  }
  release(dir: string, invocationId: string): void {
    const file = path.join(dir, "active.json");
    if (readJson<{ invocationId: string }>(file)?.invocationId === invocationId) fs.unlinkSync(file);
  }
  slot(maxConcurrent: number, workerId: string, invocationId: string): string | undefined {
    for (let index = 0; index < maxConcurrent; index++) {
      const file = path.join(this.root, "slots", `${index}.json`);
      const prior = readJson<{ ownerPid: number; processPid?: number; token: string; cleanupUnverified?: boolean }>(file);
      if (prior?.cleanupUnverified) continue;
      if (prior && !alive(prior.ownerPid) && !alive(prior.processPid)) {
        const releaseReaper = claimReaper(file, prior.token);
        if (!releaseReaper) continue;
        try {
          // Only one reaper of this generation may remove it. A late contender
          // re-reads the token and cannot unlink a replacement live slot.
          const current = readJson<{ token: string; ownerPid: number; processPid?: number }>(file);
          if (current?.token === prior.token && !alive(current.ownerPid) && !alive(current.processPid)) fs.unlinkSync(file);
        } finally { releaseReaper(); }
      }
      if (claimJson(file, { ownerPid: process.pid, workerId, invocationId, token: randomUUID() })) return file;
    }
    return undefined;
  }
  queued(onError?: (error: Error) => void): Receipt[] {
    const receipts: Receipt[] = [];
    for (const workerId of fs.readdirSync(path.join(this.root, "workers"))) {
      try {
        validId(workerId);
        const dir = this.worker(workerId);
        if (!dir) continue;
        const workerReceipts: Receipt[] = [];
        for (const file of fs.readdirSync(path.join(dir, "invocations"))) {
          if (!file.endsWith(".json")) continue;
          const receipt = this.receipt(dir, file.slice(0, -".json".length));
          if (receipt?.status === "queued") workerReceipts.push(receipt);
        }
        // A damaged receipt quarantines this worker's queue, while other
        // workers can continue. No metadata or untrusted directory is repaired.
        receipts.push(...workerReceipts);
      } catch {
        // Never echo directory names, JSON contents or raw filesystem errors:
        // they may contain control characters, task text or private paths.
        const id = UUID.test(workerId) ? workerId : `unrecognized-${hash(workerId)}`;
        const diagnostic = new Error(`Background worker queue metadata is invalid or unreadable: ${id}; retained for inspection`);
        if (onError) onError(diagnostic); else console.error(diagnostic.message);
      }
    }
    return receipts.sort((left, right) => (left.queuedAt ?? 0) - (right.queuedAt ?? 0));
  }
  remove(dir: string, workerId: string): void {
    writeJson(path.join(this.root, "tombstones", `${workerId}.json`), { workerId, cleanedAt: new Date().toISOString() });
    fs.rmSync(dir, { recursive: true });
  }
}
