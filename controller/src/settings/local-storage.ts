import * as fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { LocalSettingsDataSchema, LocalSettingsError, type LocalSettingsData } from "./local-contracts.js";
import { acquireSettingsLock } from "./local-lock.js";

const MAX_SETTINGS_BYTES = 4 * 1024 * 1024;
const FILE_NAME = "runtime-settings.json";
const SNAPSHOT_DIRECTORY = "turn-snapshots";
const SNAPSHOT_TTL_MS = 24 * 60 * 60_000;
const MAX_SNAPSHOT_FILES = 256;
export const revision = (value: unknown): string => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const empty = (): LocalSettingsData => ({ format: 1, models: {}, resources: {} });

function regular(file: string): boolean {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SETTINGS_BYTES) throw new LocalSettingsError(503, "设置文件类型或大小不合法", "SETTINGS_STORAGE_UNSAFE");
    return true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/** Fixed allowlisted file only; persisted overrides never become filesystem paths. */
export class LocalSettingsStorage {
  readonly root: string;
  private readonly file: string;
  constructor(root?: string) {
    this.root = path.resolve(root ?? ".runtime/controller-runtime/settings");
    this.file = path.join(this.root, FILE_NAME);
  }
  read(): LocalSettingsData {
    try {
      const rootStat = fs.lstatSync(this.root);
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new LocalSettingsError(503, "设置目录必须是普通目录", "SETTINGS_STORAGE_UNSAFE");
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty(); throw error; }
    if (!regular(this.file)) return empty();
    let value: unknown;
    try { value = JSON.parse(fs.readFileSync(this.file, "utf8")); }
    catch { throw new LocalSettingsError(503, "持久设置无法读取", "SETTINGS_STORAGE_INVALID"); }
    const parsed = LocalSettingsDataSchema.safeParse(value);
    if (!parsed.success) throw new LocalSettingsError(503, "持久设置格式无效", "SETTINGS_STORAGE_INVALID");
    return parsed.data;
  }

  /** Turn snapshots live outside the settings document so each message row stores only a small reference. */
  writeTurnSnapshot(reference: string, value: unknown, now = Date.now()): void {
    if (!/^[a-f0-9]{64}$/.test(reference)) throw new LocalSettingsError(400, "运行快照引用无效", "INVALID_RUNTIME_SNAPSHOT");
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized, "utf8") > MAX_SETTINGS_BYTES) throw new LocalSettingsError(400, "运行快照超过大小限制", "SNAPSHOT_TOO_LARGE");
    this.read();
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const lock = acquireSettingsLock(this.root);
    const directory = path.join(this.root, SNAPSHOT_DIRECTORY);
    const file = path.join(directory, `${reference}.json`);
    const temporary = path.join(directory, `.snapshot-${randomUUID()}.tmp`);
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const directoryStat = fs.lstatSync(directory);
      if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) throw new LocalSettingsError(503, "运行快照目录不安全", "SETTINGS_STORAGE_UNSAFE");
      if (!fs.existsSync(file)) {
        fs.writeFileSync(temporary, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
        const output = fs.openSync(temporary, fs.constants.O_RDONLY);
        try { fs.fsyncSync(output); } finally { fs.closeSync(output); }
        fs.renameSync(temporary, file);
      }
      const entries = fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => {
        const namePath = path.join(directory, name), stat = fs.lstatSync(namePath);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.size > MAX_SETTINGS_BYTES) {
          throw new LocalSettingsError(503, "运行快照文件不安全", "SETTINGS_STORAGE_UNSAFE");
        }
        return { name, mtimeMs: stat.mtimeMs };
      }).sort((left, right) => left.mtimeMs - right.mtimeMs);
      const cutoff = now - SNAPSHOT_TTL_MS;
      const removable = entries.filter(entry => entry.mtimeMs < cutoff);
      for (const entry of [...removable, ...entries.slice(0, Math.max(0, entries.length - MAX_SNAPSHOT_FILES))]) {
        try { fs.unlinkSync(path.join(directory, entry.name)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    } finally {
      try {
        try { fs.unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      } finally { lock.release(); }
    }
  }

  readTurnSnapshot(reference: string): unknown | null {
    if (!/^[a-f0-9]{64}$/.test(reference)) throw new LocalSettingsError(400, "运行快照引用无效", "INVALID_RUNTIME_SNAPSHOT");
    this.read();
    const directory = path.join(this.root, SNAPSHOT_DIRECTORY), file = path.join(directory, `${reference}.json`);
    try {
      const directoryStat = fs.lstatSync(directory);
      if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) throw new LocalSettingsError(503, "运行快照目录不安全", "SETTINGS_STORAGE_UNSAFE");
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.size > MAX_SETTINGS_BYTES) {
        throw new LocalSettingsError(503, "运行快照文件不安全", "SETTINGS_STORAGE_UNSAFE");
      }
      try { return JSON.parse(fs.readFileSync(file, "utf8")); }
      catch { throw new LocalSettingsError(503, "运行快照无法读取", "SETTINGS_STORAGE_INVALID"); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  update(change: (data: LocalSettingsData) => void): void {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.read();
    const lock = acquireSettingsLock(this.root);
    const temp = path.join(this.root, `.settings-${randomUUID()}.tmp`);
    try {
      const data = this.read();
      change(data);
      const serialized = JSON.stringify(data);
      if (Buffer.byteLength(serialized) > MAX_SETTINGS_BYTES) throw new LocalSettingsError(400, "设置总大小超过限制", "SETTINGS_TOO_LARGE");
      const output = fs.openSync(temp, "wx", 0o600);
      try { fs.writeFileSync(output, serialized); fs.fsyncSync(output); } finally { fs.closeSync(output); }
      lock.assertOwned();
      fs.renameSync(temp, this.file);
      const directory = fs.openSync(this.root, "r");
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } finally {
      try {
        try { fs.unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      } finally { lock.release(); }
    }
  }
}
