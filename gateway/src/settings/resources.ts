import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const MAX_RESOURCE_BYTES = 1024 * 1024;
const MAX_SKILL_FILES = 2048;
const MAX_SKILL_BYTES = 32 * MAX_RESOURCE_BYTES;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

export class RuntimeResourceError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = "RuntimeResourceError";
  }
}

export interface ResourceMetadata {
  id: string;
  kind: "prompt" | "skill";
  title: string;
  path: string;
  revision: string;
  version: string;
  bytes: number;
  source: "default" | "override";
  editable: boolean;
}
export interface ResourceDocument extends ResourceMetadata { content: string }
export interface RuntimeResourcesOptions {
  root: string;
  skillsRoot: string;
  /** Prompt names (e.g. main) mapped to the deployed source text. */
  defaults: Record<string, string>;
}
type SkillFile = { relative: string; file: string; source: "default" | "override" };

function fail(status: number, code: string, message: string): never {
  throw new RuntimeResourceError(status, code, message);
}
function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
function digest(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function segments(relative: string): string[] {
  const parts = relative.split("/");
  if (!relative || relative.includes("\\") || parts.some(part => !part || part === "." || part === ".." ||
      part.includes("\0") || /[\u0000-\u001f\u007f]/.test(part)) || path.isAbsolute(relative)) {
    return fail(400, "invalid_resource", "Invalid resource path");
  }
  return parts;
}
/** Validate ancestors individually: recursive mkdir and leaf-only checks follow links. */
function directory(target: string, create: boolean): boolean {
  const parsed = path.parse(target);
  let current = parsed.root;
  for (const component of target.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(current); } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
      if (!create) return false;
      try { fs.mkdirSync(current, { mode: DIRECTORY_MODE }); } catch (mkdirError) {
        if (!hasCode(mkdirError, "EEXIST")) throw mkdirError;
      }
      stat = fs.lstatSync(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      fail(400, "unsafe_resource", "Resource directories must not contain symbolic links");
    }
  }
  return true;
}
function bytes(file: string): { data: Buffer; mode: number } | undefined {
  if (!directory(path.dirname(file), false)) return undefined;
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    return fail(400, "unsafe_resource", "Resource must be a regular file without links");
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== stat.ino || opened.dev !== stat.dev) {
      return fail(409, "resource_changed", "Resource changed while being read");
    }
    if (opened.size > MAX_RESOURCE_BYTES) fail(413, "resource_too_large", "Resource exceeds the size limit");
    const buffer = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_RESOURCE_BYTES) fail(413, "resource_too_large", "Resource exceeds the size limit");
    if (length > opened.size) fail(409, "resource_changed", "Resource grew while being read");
    return { data: buffer.subarray(0, length), mode: opened.mode };
  } finally { fs.closeSync(fd); }
}
function decode(data: Buffer): string | undefined {
  if (data.includes(0)) return undefined;
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data); } catch (error) {
    if (error instanceof TypeError) return undefined;
    throw error;
  }
}
function text(content: string): void {
  if (typeof content !== "string" || content.includes("\0") ||
      Buffer.from(content, "utf8").toString("utf8") !== content) fail(400, "invalid_text", "Resource must be valid UTF-8 text");
  if (Buffer.byteLength(content, "utf8") > MAX_RESOURCE_BYTES) fail(413, "resource_too_large", "Resource exceeds the size limit");
}
function store(file: string, content: Buffer | string, mode = FILE_MODE): void {
  directory(path.dirname(file), true);
  bytes(file); // Reject an existing symlink or non-regular destination.
  const temporary = path.join(path.dirname(file), `.resource-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    directory(path.dirname(file), false);
    bytes(file);
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
  }
}

/** Repo skill metadata is discovered outside the tool sandbox; disable that second source explicitly. */
export function disabledWorkspaceSkills(workspace: string): { path: string; enabled: false }[] {
  if (typeof workspace !== "string" || !workspace.trim()) fail(400, "invalid_root", "Invalid workspace root");
  const root = path.resolve(workspace);
  if (root === path.parse(root).root) fail(400, "invalid_root", "Workspace must be a dedicated directory");
  const disabled: { path: string; enabled: false }[] = [];
  let count = 0;
  const walk = (current: string): void => {
    if (!directory(current, false)) return;
    for (const entry of fs.readdirSync(current).sort()) {
      segments(entry);
      if (++count > MAX_SKILL_FILES) fail(413, "skill_tree_too_large", "Workspace skill tree exceeds the size limit");
      const file = path.join(current, entry);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) fail(400, "unsafe_resource", "Workspace skill tree must not contain symbolic links");
      if (stat.isDirectory()) walk(file);
      else if (entry === "SKILL.md") {
        if (!stat.isFile() || stat.nlink !== 1) fail(400, "unsafe_resource", "Workspace skill must be a regular file without links");
        disabled.push({ path: file, enabled: false });
      }
    }
  };
  try { walk(path.join(root, ".agents", "skills")); } catch (error) {
    if (error instanceof RuntimeResourceError) throw error;
    throw new RuntimeResourceError(500, "resource_storage_failed", "Workspace skill inspection failed");
  }
  return disabled;
}

/**
 * Files are edited in a durable overlay; each turn gets a separate frozen skill tree.
 * One Gateway process owns a resource root. Synchronous compare-and-swap and rename
 * keep updates indivisible within its event loop, including across store instances.
 * Multi-process writers require a transactional store rather than a crash-prone lock file.
 */
export class RuntimeResources {
  private readonly root: string;
  private readonly skillsRoot: string;
  private readonly defaults: Record<string, string>;
  constructor(options: RuntimeResourcesOptions) {
    this.root = path.resolve(options.root);
    this.skillsRoot = path.resolve(options.skillsRoot);
    if ([this.root, this.skillsRoot].some(value => value === path.parse(value).root)) {
      fail(400, "invalid_root", "Resource root must be a dedicated directory");
    }
    this.defaults = { ...options.defaults };
    for (const [name, content] of Object.entries(this.defaults)) {
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) fail(400, "invalid_resource", "Invalid prompt name");
      text(content);
    }
  }

  list(): ResourceMetadata[] {
    return this.operation(() => [
      ...Object.keys(this.defaults).sort().map(name => this.read(`prompt/${name}`)),
      ...this.skillFiles().map(file => this.describe(`skill/${file.relative}`, file)),
    ].map(({ id, kind, title, path: resourcePath, revision, version, bytes: size, source, editable }) =>
      ({ id, kind, title, path: resourcePath, revision, version, bytes: size, source, editable })));
  }

  read(id: string): ResourceDocument {
    return this.operation(() => {
      const parts = segments(id);
      if (parts[0] === "prompt" && parts.length === 2 && Object.hasOwn(this.defaults, parts[1])) {
        const override = bytes(path.join(this.root, "prompts", `${parts[1]}.md`));
        const data = override?.data ?? Buffer.from(this.defaults[parts[1]], "utf8");
        const content = decode(data);
        if (content === undefined) return fail(400, "invalid_text", "Resource is not valid UTF-8 text");
        return { ...this.metadata(id, data, override ? "override" : "default", true), content };
      }
      if (parts[0] === "skill" && parts.length >= 3) {
        const file = this.skillFiles().find(candidate => candidate.relative === parts.slice(1).join("/"));
        if (file) {
          const data = bytes(file.file);
          if (!data) return fail(404, "resource_not_found", "Resource does not exist");
          const content = decode(data.data);
          if (content === undefined) return fail(400, "binary_resource", "Binary skill files can be viewed as metadata only");
          return { ...this.metadata(id, data.data, file.source, true), content };
        }
      }
      return fail(404, "resource_not_found", "Resource does not exist");
    });
  }

  write(id: string, update: { content: string; expectedRevision: string }): ResourceDocument {
    return this.operation(() => {
      text(update.content);
      if (typeof update.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(update.expectedRevision)) {
        fail(400, "invalid_revision", "A valid expectedRevision is required");
      }
      const current = this.read(id);
      if (current.revision !== update.expectedRevision) fail(409, "revision_conflict", "Resource changed; reload before saving");
      const parts = segments(id);
      const destination = current.kind === "prompt"
        ? path.join(this.root, "prompts", `${parts[1]}.md`)
        : path.join(this.root, "skills", ...parts.slice(1));
      let mode = FILE_MODE;
      if (current.kind === "skill") {
        const source = this.skillFiles().find(file => file.relative === parts.slice(1).join("/"));
        if (!source) return fail(404, "resource_not_found", "Resource does not exist");
        mode |= (bytes(source.file)?.mode ?? 0) & 0o111;
      }
      store(destination, update.content, mode);
      return this.read(id);
    });
  }

  snapshotSkills(destination: string): ResourceMetadata[] {
    return this.operation(() => {
      const target = path.resolve(destination);
      for (const source of [this.root, this.skillsRoot]) {
        if (target === source || target.startsWith(source + path.sep) || source.startsWith(target + path.sep)) {
          fail(400, "invalid_snapshot", "Skill snapshot must be separate from resource storage");
        }
      }
      const files = this.skillFiles();
      directory(target, true);
      if (fs.readdirSync(target).length) fail(409, "snapshot_exists", "Skill snapshot directory must be empty");
      const metadata: ResourceMetadata[] = [];
      for (const file of files) {
        const data = bytes(file.file);
        if (!data) fail(409, "resource_changed", "Skill changed while snapshotting");
        store(path.join(target, ...segments(file.relative)), data.data, FILE_MODE | (data.mode & 0o111));
        metadata.push(this.metadata(`skill/${file.relative}`, data.data, file.source, decode(data.data) !== undefined));
      }
      return metadata;
    });
  }

  private metadata(id: string, data: Buffer, source: "default" | "override", editable: boolean): ResourceMetadata {
    const revision = digest(data);
    return { id, kind: id.startsWith("prompt/") ? "prompt" : "skill", title: id.split("/").at(-1)!,
      path: id.slice(id.indexOf("/") + 1), revision, version: `sha256:${revision}`, bytes: data.length, source, editable };
  }
  private describe(id: string, file: SkillFile): ResourceMetadata {
    const data = bytes(file.file);
    if (!data) return fail(409, "resource_changed", "Skill changed while being read");
    return this.metadata(id, data.data, file.source, decode(data.data) !== undefined);
  }
  private skillFiles(): SkillFile[] {
    const merged = new Map<string, SkillFile>();
    let total = 0;
    const walk = (root: string, relative: string, source: "default" | "override"): void => {
      const current = path.join(root, ...relative.split("/").filter(Boolean));
      if (!directory(current, false)) return;
      for (const entry of fs.readdirSync(current).sort()) {
        segments(entry);
        const next = relative ? `${relative}/${entry}` : entry;
        const file = path.join(current, entry);
        const stat = fs.lstatSync(file);
        if (stat.isSymbolicLink()) fail(400, "unsafe_resource", "Skill tree must not contain symbolic links");
        if (stat.isDirectory()) walk(root, next, source);
        else {
          const data = bytes(file);
          if (!data) fail(409, "resource_changed", "Skill changed while being read");
          total += data.data.length;
          if (total > MAX_SKILL_BYTES || merged.size >= MAX_SKILL_FILES) fail(413, "skill_tree_too_large", "Skill tree exceeds the size limit");
          merged.set(next, { relative: next, file, source });
        }
      }
    };
    walk(this.skillsRoot, "", "default");
    walk(path.join(this.root, "skills"), "", "override");
    return [...merged.values()].filter(file => file.relative.includes("/")).sort((a, b) => a.relative.localeCompare(b.relative));
  }
  private operation<T>(action: () => T): T {
    try { return action(); } catch (error) {
      if (error instanceof RuntimeResourceError) throw error;
      throw new RuntimeResourceError(500, "resource_storage_failed", "Resource storage operation failed");
    }
  }
}
