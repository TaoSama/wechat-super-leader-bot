import * as fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { LocalSettingsError } from "./local-contracts.js";

const PROCESS_STARTED_AT = Date.now() - process.uptime() * 1000;
const START_TOLERANCE_MS = 1000;
const MAX_LOCK_BYTES = 1024;
interface Owner { pid: number; startedAt: number; token: string }
function ownerAlive(owner: Owner): boolean {
  if (owner.pid === process.pid) return Math.abs(owner.startedAt - PROCESS_STARTED_AT) < START_TOLERANCE_MS;
  try { process.kill(owner.pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    throw error;
  }
}
function readOwner(file: string): { owner: Owner; text: string; inode: number } | undefined {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_LOCK_BYTES) throw new Error("Invalid lock file");
    const text = fs.readFileSync(file, "utf8"), owner = JSON.parse(text) as Owner;
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || !Number.isFinite(owner.startedAt) || typeof owner.token !== "string" || !owner.token) throw new Error("Invalid lock owner");
    return { owner, text, inode: stat.ino };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new LocalSettingsError(503, "设置写入锁不可验证，需要检查存储", "SETTINGS_LOCK_INVALID");
  }
}

/** Synchronous writers in the same OS process namespace; a dead PID is recoverable, a live owner is never stolen by a timer. */
export function acquireSettingsLock(root: string): { assertOwned(): void; release(): void } {
  const lock = path.join(root, ".write-lock"), candidate = path.join(root, `.lock-owner-${randomUUID()}.tmp`);
  const owner: Owner = { pid: process.pid, startedAt: PROCESS_STARTED_AT, token: randomUUID() };
  fs.writeFileSync(candidate, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
  let acquired = false;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { fs.linkSync(candidate, lock); acquired = true; break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const existing = readOwner(lock);
      if (!existing) continue;
      if (ownerAlive(existing.owner)) throw new LocalSettingsError(409, "设置正在被另一个进程保存，请重试", "SETTINGS_WRITE_CONFLICT");
      const unchanged = readOwner(lock);
      if (unchanged?.inode === existing.inode && unchanged.text === existing.text) {
        try { fs.unlinkSync(lock); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    }
    if (!acquired) throw new LocalSettingsError(409, "设置写入锁已有变化，请重试", "SETTINGS_WRITE_CONFLICT");
  } finally { fs.unlinkSync(candidate); }
  const assertOwned = () => {
    const existing = readOwner(lock);
    if (!existing || existing.owner.token !== owner.token) throw new LocalSettingsError(503, "设置写入锁的归属发生变化", "SETTINGS_LOCK_LOST");
  };
  return { assertOwned, release: () => { assertOwned(); fs.unlinkSync(lock); } };
}
