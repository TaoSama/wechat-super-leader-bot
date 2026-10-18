import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkerArtifact } from "./contracts.js";
import { alive, hash, type WorkerStorage, writeJson } from "./storage.js";

const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;

export function exportWorkerArtifacts(store: WorkerStorage, dir: string, invocationId: string): WorkerArtifact[] {
  const receipt = store.receipt(dir, invocationId);
  if (!receipt || receipt.status === "queued" || receipt.status === "running" || receipt.status === "unknown") throw new Error("Worker result is not ready to export");
  if (alive(receipt.processPid) || receipt.processCleanupUnverified) throw new Error("Worker process cleanup is unverified");
  if (receipt.exported) return receipt.artifacts ?? [];
  if (receipt.attachments.length === 0) {
    store.save(dir, { ...receipt, artifacts: [], exported: true });
    return [];
  }
  const workspace = path.join(dir, "workspace");
  const destination = path.join(store.artifacts, receipt.workerId, invocationId);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  if (fs.realpathSync(destination) !== destination) throw new Error("Unsafe artifact destination");
  try {
    const artifacts: WorkerArtifact[] = [];
    for (const [index, relative] of receipt.attachments.entries()) {
      if (path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => part === ".." || part === "")) throw new Error("Attachment must be a workspace relative file");
      const source = path.resolve(workspace, relative);
      if (!source.startsWith(workspace + path.sep) || fs.realpathSync(path.dirname(source)) !== path.dirname(source)) {
        throw new Error("Attachment crosses its worker workspace");
      }
      const fd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      let data: Buffer;
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_ARTIFACT_BYTES) throw new Error("Attachment must be a bounded ordinary file");
        data = fs.readFileSync(fd);
        if (data.length > MAX_ARTIFACT_BYTES) throw new Error("Attachment exceeded its size limit");
      } finally { fs.closeSync(fd); }
      const name = path.basename(relative);
      const target = path.join(destination, `${index}-${name}`);
      // Export is repeatable after an interrupted copy; metadata is committed last.
      fs.writeFileSync(target, data, { mode: 0o600, flag: "w" });
      const targetFd = fs.openSync(target, "r");
      try { fs.fsyncSync(targetFd); } finally { fs.closeSync(targetFd); }
      artifacts.push({ name, path: target, size: data.length, sha256: hash(data) });
    }
    writeJson(path.join(destination, "result.json"), { workerId: receipt.workerId, invocationId, artifacts });
    store.save(dir, { ...receipt, artifacts, exported: true });
    return artifacts;
  } catch (error) {
    // Unaccepted partial exports have no download-retention marker.
    try {
      fs.rmSync(destination, { recursive: true, force: true });
      try { fs.rmdirSync(path.dirname(destination)); }
      catch (cleanupError) {
        if (!["ENOTEMPTY", "ENOENT"].includes((cleanupError as NodeJS.ErrnoException).code ?? "")) throw cleanupError;
      }
    } catch (cleanupError) { throw new AggregateError([error, cleanupError], "Unable to discard incomplete worker artifacts"); }
    throw error;
  }
}
