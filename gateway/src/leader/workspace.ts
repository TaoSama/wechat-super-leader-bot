import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ControllerMessageResponse } from "../types.js";
import { hasConsoleCredential } from "./control-mcp.js";
import { validateImageAttachments } from "../wechat/media-delivery.js";
import { agentInstructionsStatus, DEFAULT_AGENT_INSTRUCTIONS } from "./agent-instructions.js";

export type MemoryFile = "task.md" | "memory.md" | "preference.md";
export type MemorySnapshot = Record<MemoryFile, { content: string; truncated: boolean }>;
export const MEMORY_SNAPSHOT_BYTES = 24 * 1024;
export type ReplyJournal = Record<string, {
  inputHash: string;
  stage: "started" | "failed" | "completed";
  reply?: ControllerMessageResponse;
  delivery?: "pending" | "accepted" | "uncertain" | "expired";
  provenance?: "codex" | "controller-console";
  controllerMessageId?: string;
  consoleText?: string;
  steering?: {
    rootMessageId: string;
    threadId: string;
    turnId: string;
    status: "submitting" | "accepted" | "uncertain";
  };
}>;
const MAX_MIGRATION_BYTES = 1024 * 1024;
export const MAX_REPLY_JOURNAL_BYTES = 16 * 1024 * 1024;
export const MAX_REPLY_ENTRY_BYTES = 128 * 1024;
export const MAX_REPLY_JOURNAL_ENTRIES = 192;
export const MAX_PINNED_REPLY_ENTRIES = 128;
export const MAX_CLOSED_REPLY_ENTRIES = 64;
export const MAX_REPLY_CHARS = 16000;
const REPLY_JOURNAL_FILE = ".replies.json";
const LEGACY_PREFERENCE_FILE = "profile.md";
const AGENT_INSTRUCTIONS_FILE = "AGENTS.md";
const MAX_ID_BYTES = 4096;
const MAX_THREAD_BYTES = 4096;
const THREAD_FILE = ".thread.json";
const STATIC_REVISION = /^[a-f0-9]{64}$/;
const STATIC_SOURCES: readonly StaticLayerSource[] = ["start", "input"];
export type StaticLayerSource = "start" | "input";
export interface ThreadStaticLayers { revision: string; source: StaticLayerSource }
export interface ThreadState { threadId: string; staticLayers?: ThreadStaticLayers }
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MEMORY_TEMPLATES: Record<MemoryFile, string> = {
  "task.md": "# 当前任务\n\n记录当前任务的目标、进度和待办。\n\n",
  "memory.md": "# 长期记忆\n\n记录跨任务有用的事实、决策和经验。\n\n",
  "preference.md": "# 用户偏好\n\n记录用户明确表达的偏好和协作习惯。\n\n",
};
function digest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export function storageOperation<T>(action: () => T): T {
  try {
    return action();
  } catch (error: unknown) {
    if (error instanceof WorkspaceValidationError) throw error;
    // Never expose native filesystem paths or JSON parser snippets to the agent.
    throw new Error("Workspace storage operation failed");
  }
}

export class WorkspaceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceValidationError";
  }
}

function validateText(content: string, limit: number): void {
  if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > limit) {
    throw new WorkspaceValidationError("Workspace text exceeds the size limit or is invalid");
  }
}

/**
 * An entry stays pinned until Gateway records a terminal receipt; until then a
 * crashed "started" turn replays its frozen reply instead of rerunning. Gateway
 * sends that receipt only after durably marking the inbound processed, and it
 * never removes uncertain/expired outbox records, so replay dedupe no longer
 * depends on this entry. Accepted entries rely on the bounded processed-key
 * window, as completed accepted entries always have.
 */
export function isPinnedReplyEntry(entry: Pick<ReplyJournal[string], "delivery">): boolean {
  return (entry.delivery ?? "pending") === "pending";
}

function validateReplyJournal(value: unknown): ReplyJournal {
  const invalid = (): never => { throw new WorkspaceValidationError("Invalid workspace reply journal"); };
  const object = (candidate: unknown): candidate is Record<string, unknown> =>
    typeof candidate === "object" && candidate !== null && !Array.isArray(candidate);
  if (!object(value) || Object.keys(value).length > MAX_REPLY_JOURNAL_ENTRIES) return invalid();
  const entries: [string, ReplyJournal[string]][] = [];
  let pinned = 0;
  for (const [key, entry] of Object.entries(value)) {
    if (!/^[a-f0-9]{64}$/.test(key) || !object(entry) ||
        Object.keys(entry).some(name => !["inputHash", "stage", "reply", "delivery", "provenance", "steering", "controllerMessageId", "consoleText"].includes(name)) ||
        typeof entry.inputHash !== "string" || !/^[a-f0-9]{64}$/.test(entry.inputHash) ||
        (entry.stage !== "started" && entry.stage !== "failed" && entry.stage !== "completed") ||
        (entry.delivery !== undefined && !["pending", "accepted", "uncertain", "expired"].includes(entry.delivery as string)) ||
        (entry.provenance !== undefined && !["codex", "controller-console"].includes(entry.provenance as string)) ||
        (entry.provenance === "controller-console" && entry.stage !== "completed") ||
        (entry.controllerMessageId !== undefined && (entry.provenance !== "controller-console" ||
          typeof entry.controllerMessageId !== "string" || !entry.controllerMessageId.trim() ||
          Buffer.byteLength(entry.controllerMessageId) > MAX_ID_BYTES)) ||
        (entry.consoleText !== undefined && (entry.provenance !== "controller-console" ||
          typeof entry.consoleText !== "string" || !entry.consoleText.includes("#login=[REDACTED]") ||
          entry.consoleText.length > MAX_REPLY_CHARS)) ||
        hasConsoleCredential(JSON.stringify(entry)) ||
        Buffer.byteLength(JSON.stringify(entry), "utf8") > MAX_REPLY_ENTRY_BYTES) return invalid();
    const steering = entry.steering;
    if (steering !== undefined && (!object(steering) ||
        Object.keys(steering).some(name => !["rootMessageId", "threadId", "turnId", "status"].includes(name)) ||
        !["rootMessageId", "threadId", "turnId"].every(name => typeof steering[name] === "string" &&
          Boolean((steering[name] as string).trim()) && Buffer.byteLength(steering[name] as string) <= MAX_ID_BYTES) ||
        !["submitting", "accepted", "uncertain"].includes(steering.status as string) ||
        (steering.status === "accepted" ? entry.stage !== "completed" || entry.delivery !== "accepted"
          : entry.stage !== "started") || entry.provenance !== undefined)) return invalid();
    // Closed entries are bounded by the total cap: older journals pinned started
    // and uncertain entries that now count as closed until the next prune.
    if (isPinnedReplyEntry(entry as ReplyJournal[string]) && ++pinned > MAX_PINNED_REPLY_ENTRIES) return invalid();
    const reply = entry.reply;
    if (reply === undefined) {
      if (entry.stage === "completed" || entry.stage === "failed") return invalid();
    } else if (!object(reply) || Object.keys(reply).some(name =>
        !(entry.provenance === "controller-console" && entry.consoleText === undefined ? ["text"] : ["text", "commandId", "images", "imageSourceMessageId"]).includes(name)) ||
        typeof reply.text !== "string" || reply.text.length > MAX_REPLY_CHARS ||
        (reply.commandId !== undefined && (typeof reply.commandId !== "string" ||
          !reply.commandId.trim() || reply.commandId.length > MAX_ID_BYTES)) ||
        (reply.imageSourceMessageId !== undefined && (typeof reply.imageSourceMessageId !== "string" ||
          !reply.imageSourceMessageId.trim() || Buffer.byteLength(reply.imageSourceMessageId) > MAX_ID_BYTES ||
          !Array.isArray(reply.images) || reply.images.length === 0))) return invalid();
    if (entry.consoleText !== undefined && (!reply || typeof reply.text !== "string" ||
        reply.text.split(entry.consoleText as string).length !== 2)) return invalid();
    let images: ControllerMessageResponse["images"];
    if (reply !== undefined && reply.images !== undefined) {
      try { images = validateImageAttachments(reply.images); } catch { return invalid(); }
    }
    entries.push([key, { inputHash: entry.inputHash, stage: entry.stage,
      ...(entry.delivery !== undefined ? { delivery: entry.delivery as ReplyJournal[string]["delivery"] } : {}),
      ...(entry.provenance !== undefined ? { provenance: entry.provenance as ReplyJournal[string]["provenance"] } : {}),
      ...(entry.consoleText !== undefined ? { consoleText: entry.consoleText as string } : {}),
      ...(entry.controllerMessageId !== undefined ? { controllerMessageId: entry.controllerMessageId as string } : {}),
      ...(steering !== undefined ? { steering: steering as ReplyJournal[string]["steering"] } : {}),
      ...(reply !== undefined ? { reply: {
        text: reply.text as string,
        ...(reply.commandId !== undefined ? { commandId: reply.commandId as string } : {}),
        ...(images !== undefined ? { images } : {}),
        ...(reply.imageSourceMessageId !== undefined ? { imageSourceMessageId: reply.imageSourceMessageId as string } : {}),
      } } : {}),
    }]);
  }
  const journal = Object.fromEntries(entries);
  if (Buffer.byteLength(JSON.stringify(journal) + "\n", "utf8") > MAX_REPLY_JOURNAL_BYTES) return invalid();
  return journal;
}

/** Check every ancestor as well as the leaf; recursive mkdir would follow links. */
export function ensureDirectory(directory: string, create: boolean, privateMode = false): void {
  const parsed = path.parse(directory);
  let current = parsed.root;
  for (const component of directory.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error: unknown) {
      if (!create || !hasCode(error, "ENOENT")) throw error;
      try {
        fs.mkdirSync(current, { mode: DIRECTORY_MODE });
      } catch (mkdirError: unknown) {
        if (!hasCode(mkdirError, "EEXIST")) throw mkdirError;
      }
      stat = fs.lstatSync(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new WorkspaceValidationError("Workspace directory must not contain symbolic links");
    }
  }
  if (privateMode) fs.chmodSync(directory, DIRECTORY_MODE);
}

export function assertRegularFile(file: string): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error: unknown) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new WorkspaceValidationError("Workspace file must be a regular private file");
  }
  return true;
}

export function readText(file: string, limit: number, strictUtf8 = false): string | undefined {
  if (!assertRegularFile(file)) return undefined;
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) {
      throw new WorkspaceValidationError("Workspace file is invalid or exceeds the size limit");
    }
    fs.fchmodSync(fd, FILE_MODE);
    // Read at most limit + 1 bytes, including if an external writer grows the file.
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > limit) throw new WorkspaceValidationError("Workspace file exceeds the size limit");
    if (strictUtf8) {
      try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length)); }
      catch { throw new WorkspaceValidationError("Editable file must be valid UTF-8 text"); }
    }
    return buffer.subarray(0, length).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function readMemoryPrefix(file: string): { content: string; truncated: boolean } {
  if (!assertRegularFile(file)) return { content: "", truncated: false };
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new WorkspaceValidationError("Workspace file must be a regular private file");
    }
    fs.fchmodSync(fd, FILE_MODE);
    const buffer = Buffer.alloc(MEMORY_SNAPSHOT_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    const truncated = length > MEMORY_SNAPSHOT_BYTES;
    // Streaming decoding omits an incomplete final UTF-8 sequence when truncated.
    const decoder = new TextDecoder("utf-8");
    const content = decoder.decode(buffer.subarray(0, Math.min(length, MEMORY_SNAPSHOT_BYTES)), { stream: truncated });
    return { content, truncated };
  } finally {
    fs.closeSync(fd);
  }
}

export function atomicWrite(file: string, content: string | Buffer): void {
  assertRegularFile(file);
  const directory = path.dirname(file);
  const temporary = path.join(directory, `.write-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT |
      fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, FILE_MODE);
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    assertRegularFile(file);
    fs.renameSync(temporary, file);
    const directoryFd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      fs.fsyncSync(directoryFd);
    } finally {
      fs.closeSync(directoryFd);
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.unlinkSync(temporary);
    } catch (error: unknown) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
  }
}

export class LeaderWorkspace {
  public readonly codexHome: string;

  constructor(public readonly key: string, public readonly workspacePath: string, private readonly root: string) {
    this.codexHome = path.join(workspacePath, ".codex");
  }

  public initialize(): void {
    storageOperation(() => {
      ensureDirectory(this.root, true, true);
      ensureDirectory(this.workspacePath, true, true);
      ensureDirectory(this.codexHome, true, true);
      this.migratePreference();
      for (const name of Object.keys(MEMORY_TEMPLATES) as MemoryFile[]) {
        const file = path.join(this.workspacePath, name);
        if (!assertRegularFile(file)) {
          atomicWrite(file, MEMORY_TEMPLATES[name]);
        } else {
          const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
          try {
            fs.fchmodSync(fd, FILE_MODE);
          } finally {
            fs.closeSync(fd);
          }
        }
      }
      const instructions = path.join(this.workspacePath, AGENT_INSTRUCTIONS_FILE);
      if (!assertRegularFile(instructions)) {
        atomicWrite(instructions, DEFAULT_AGENT_INSTRUCTIONS);
      } else {
        const existing = readMemoryPrefix(instructions);
        if (!existing.truncated && agentInstructionsStatus(existing.content) === "outdated-default") {
          atomicWrite(instructions, DEFAULT_AGENT_INSTRUCTIONS);
        }
      }
      this.getThreadId();
    });
  }

  private migratePreference(): void {
    const legacyPath = path.join(this.workspacePath, LEGACY_PREFERENCE_FILE);
    const legacy = readText(legacyPath, MAX_MIGRATION_BYTES);
    if (legacy === undefined) return;
    const preferencePath = path.join(this.workspacePath, "preference.md");
    const current = readText(preferencePath, MAX_MIGRATION_BYTES);
    if (current === undefined || !current.trim()) {
      atomicWrite(preferencePath, legacy);
    } else if (legacy.trim() && !current.includes(legacy)) {
      // Persist both before removing the legacy name; retrying after a crash is idempotent.
      atomicWrite(preferencePath, `${current}\n\n${legacy}`);
    }
    fs.unlinkSync(legacyPath);
  }

  private checkLayout(): void {
    ensureDirectory(this.root, false, true);
    ensureDirectory(this.workspacePath, false, true);
    ensureDirectory(this.codexHome, false, true);
  }

  public readMemory(): MemorySnapshot {
    return storageOperation(() => {
      this.checkLayout();
      return Object.fromEntries((Object.keys(MEMORY_TEMPLATES) as MemoryFile[])
        .map(name => [name, readMemoryPrefix(path.join(this.workspacePath, name))])) as MemorySnapshot;
    });
  }

  public readEditableFile(name: MemoryFile | "AGENTS.md"): { content: string; revision: string } {
    return storageOperation(() => {
      if (!["task.md", "memory.md", "preference.md", "AGENTS.md"].includes(name)) throw new WorkspaceValidationError("Invalid editable file");
      this.checkLayout();
      const content = readText(path.join(this.workspacePath, name), MAX_MIGRATION_BYTES, true);
      if (content === undefined) throw new WorkspaceValidationError("Editable file is missing");
      return { content, revision: digest(content) };
    });
  }

  public writeEditableFile(name: MemoryFile | "AGENTS.md", content: string, expectedRevision: string): boolean {
    return storageOperation(() => {
      validateText(content, MAX_MIGRATION_BYTES);
      if (content.includes("\0") || Buffer.from(content, "utf8").toString("utf8") !== content) throw new WorkspaceValidationError("Invalid editable text");
      if (this.readEditableFile(name).revision !== expectedRevision) return false;
      atomicWrite(path.join(this.workspacePath, name), content);
      return true;
    });
  }

  public getReplyJournal(): ReplyJournal {
    return storageOperation(() => {
      this.checkLayout();
      const raw = readText(path.join(this.workspacePath, REPLY_JOURNAL_FILE), MAX_REPLY_JOURNAL_BYTES);
      if (raw === undefined) return {};
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch {
        throw new WorkspaceValidationError("Invalid workspace reply journal");
      }
      return validateReplyJournal(parsed);
    });
  }

  public setReplyJournal(journal: ReplyJournal): void {
    storageOperation(() => {
      const content = JSON.stringify(validateReplyJournal(journal)) + "\n";
      validateText(content, MAX_REPLY_JOURNAL_BYTES);
      this.checkLayout();
      atomicWrite(path.join(this.workspacePath, REPLY_JOURNAL_FILE), content);
    });
  }

  /**
   * Reads .thread.json. staticRevision is the hash of the static layers the thread holds; staticSource says how it got
   * them: "start" via thread/start developer instructions (re-injected by Codex after compaction), "input" via turn input.
   */
  private readThreadState(): ThreadState | undefined {
    const raw = readText(path.join(this.workspacePath, THREAD_FILE), MAX_THREAD_BYTES);
    if (raw === undefined) return undefined;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new WorkspaceValidationError("Invalid workspace thread state"); }
    if (typeof parsed !== "object" || parsed === null || !("threadId" in parsed) ||
        typeof parsed.threadId !== "string" || !parsed.threadId.trim()) throw new WorkspaceValidationError("Invalid workspace thread state");
    const lastInputTokens = "lastInputTokens" in parsed ? parsed.lastInputTokens : undefined;
    const rotateBeforeNext = "rotateBeforeNext" in parsed ? parsed.rotateBeforeNext : undefined;
    const staticRevision = "staticRevision" in parsed ? parsed.staticRevision : undefined;
    const staticSource = "staticSource" in parsed ? parsed.staticSource : undefined;
    if (lastInputTokens !== undefined && (typeof lastInputTokens !== "number" || !Number.isSafeInteger(lastInputTokens) || lastInputTokens < 0) ||
        (rotateBeforeNext !== undefined && typeof rotateBeforeNext !== "boolean") ||
        (staticRevision !== undefined && (typeof staticRevision !== "string" || !STATIC_REVISION.test(staticRevision))) ||
        (staticSource !== undefined && !STATIC_SOURCES.includes(staticSource as StaticLayerSource))) {
      throw new WorkspaceValidationError("Invalid workspace thread state");
    }
    // A revision without a source counts as unrecorded, so the thread keeps getting the static layers in its input.
    return { threadId: parsed.threadId, ...(staticRevision === undefined || staticSource === undefined ? {} :
      { staticLayers: { revision: staticRevision as string, source: staticSource as StaticLayerSource } }) };
  }

  private writeThreadState(state: ThreadState, lastInputTokens: number): void {
    const content = JSON.stringify({ threadId: state.threadId, lastInputTokens,
      ...(state.staticLayers ? { staticRevision: state.staticLayers.revision, staticSource: state.staticLayers.source } : {}) }) + "\n";
    validateText(content, MAX_THREAD_BYTES);
    atomicWrite(path.join(this.workspacePath, THREAD_FILE), content);
  }

  public getThreadId(): string | undefined {
    return this.getThreadState()?.threadId;
  }

  /** staticLayers is undefined for threads that predate the record. */
  public getThreadState(): ThreadState | undefined {
    return storageOperation(() => { this.checkLayout(); return this.readThreadState(); });
  }

  /** Without staticLayers, the recorded ones are kept only while the thread stays the same. */
  public setThreadId(id: string, staticLayers?: ThreadStaticLayers): void {
    storageOperation(() => {
      if (typeof id !== "string" || !id.trim()) throw new WorkspaceValidationError("Invalid thread ID");
      if (staticLayers !== undefined && (!STATIC_REVISION.test(staticLayers.revision) || !STATIC_SOURCES.includes(staticLayers.source))) {
        throw new WorkspaceValidationError("Invalid static layers");
      }
      this.checkLayout();
      const previous = staticLayers === undefined ? this.readThreadState() : undefined;
      const kept = previous?.threadId === id ? previous.staticLayers : staticLayers;
      this.writeThreadState({ threadId: id, ...(kept === undefined ? {} : { staticLayers: kept }) }, 0);
    });
  }

  /** Usage is diagnostic; native compaction preserves the conversation identity. */
  public recordThreadUsage(inputTokens: number): void {
    storageOperation(() => {
      if (!Number.isSafeInteger(inputTokens) || inputTokens < 0) throw new WorkspaceValidationError("Invalid thread usage");
      this.checkLayout();
      const state = this.readThreadState();
      if (state) this.writeThreadState(state, inputTokens);
    });
  }
}

export class WorkspaceStore {
  private readonly root: string;

  constructor(root: string) {
    if (typeof root !== "string" || !root.trim()) throw new WorkspaceValidationError("Invalid workspace root");
    this.root = path.resolve(root);
    if (this.root === path.parse(this.root).root) throw new WorkspaceValidationError("Invalid workspace root");
  }

  private chatKey(accountId: string, chatId: string): string {
    for (const id of [accountId, chatId]) {
      if (typeof id !== "string" || !id.trim() || Buffer.byteLength(id, "utf8") > MAX_ID_BYTES) {
        throw new WorkspaceValidationError("A stable account ID and chat ID are required");
      }
    }
    return digest(JSON.stringify([accountId, chatId]));
  }

  public async findChat(accountId: string, chatId: string): Promise<LeaderWorkspace | undefined> {
    const key = this.chatKey(accountId, chatId);
    const workspace = new LeaderWorkspace(key, path.join(this.root, key), this.root);
    return storageOperation(() => {
      try {
        for (const directory of [this.root, workspace.workspacePath, workspace.codexHome]) {
          ensureDirectory(directory, false);
        }
      } catch (error: unknown) {
        if (hasCode(error, "ENOENT")) return undefined;
        throw error;
      }
      return workspace;
    });
  }

  public async forChat(accountId: string, chatId: string): Promise<LeaderWorkspace> {
    const key = this.chatKey(accountId, chatId);
    const workspace = new LeaderWorkspace(key, path.join(this.root, key), this.root);
    workspace.initialize();
    return workspace;
  }
}
