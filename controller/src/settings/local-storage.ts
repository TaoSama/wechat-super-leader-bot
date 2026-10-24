import * as fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { LocalSettingsDataSchema, LocalSettingsError, type LocalSettingsData } from "./local-contracts.js";
import { acquireSettingsLock } from "./local-lock.js";

const MAX_SETTINGS_BYTES = 4 * 1024 * 1024;
const FILE_NAME = "runtime-settings.json";
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
    this.root = path.resolve(root ?? ".runtime/controller-settings");
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
      try { fs.unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      lock.release();
    }
  }
}
