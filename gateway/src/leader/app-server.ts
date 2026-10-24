import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import type { CodexOptions, ThreadEvent, ThreadItem, ThreadOptions, Usage } from "@openai/codex-sdk";

const RPC_TIMEOUT_MS = 30_000;
const EXIT_GRACE_MS = 1_000;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_BUFFERED_EVENTS = 1024;
const ENV_ALLOWLIST = new Set(["HOME", "CODEX_HOME", "PATH", "LANG", "LC_ALL", "TZ", "SSL_CERT_FILE",
  "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "LEADER_TURN_MCP_TOKEN"]);
const EMPTY_USAGE: Usage = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0,
  output_tokens: 0, reasoning_output_tokens: 0 };
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as ObjectValue : {};
const string = (value: unknown): string => typeof value === "string" ? value : "";
const number = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : 0;

/** A protocol refusal proves the server did not accept a steer; transport failures do not. */
export class AppServerRejectedError extends Error {
  constructor(public readonly code: number) { super("Codex app-server rejected the request"); }
}

export interface AppServerTurn {
  readonly threadId: string;
  readonly turnId: string;
  readonly events: AsyncIterable<ThreadEvent>;
  steer(text: string, expectedTurnId: string): Promise<void>;
  close(): Promise<void>;
}

export type ThreadStartedHandler = (threadId: string) => void | Promise<void>;

function toml(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value) || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(toml).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).map(([key, entry]) =>
    `${JSON.stringify(key)}=${toml(entry)}`).join(",")}}`;
  throw new Error("Invalid Codex configuration value");
}

function binary(options: CodexOptions): { executable: string; pathDirectory?: string } {
  if (options.codexPathOverride) return { executable: options.codexPathOverride };
  const platform = process.platform === "android" ? "linux" : process.platform;
  const architecture = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : undefined;
  const suffixes: Record<string, string | undefined> = { linux: "unknown-linux-musl", darwin: "apple-darwin", win32: "pc-windows-msvc" };
  const suffix = suffixes[platform];
  if (!architecture || !suffix) throw new Error("Unsupported Codex app-server platform");
  const sdkRequire = createRequire(import.meta.resolve("@openai/codex-sdk"));
  const codexRequire = createRequire(sdkRequire.resolve("@openai/codex/package.json"));
  const packageRoot = path.dirname(codexRequire.resolve(`@openai/codex-${platform}-${process.arch}/package.json`));
  const nativeRoot = path.join(packageRoot, "vendor", `${architecture}-${suffix}`);
  const executableName = platform === "win32" ? "codex.exe" : "codex";
  for (const [binDirectory, pathDirectory] of [["bin", "codex-path"], ["codex", "path"]]) {
    const executable = path.join(nativeRoot, binDirectory, executableName);
    if (existsSync(executable)) return { executable, pathDirectory: path.join(nativeRoot, pathDirectory) };
  }
  throw new Error("Codex app-server binary is unavailable");
}

class EventQueue {
  private readonly values: ThreadEvent[] = [];
  private wake?: () => void;
  private ended = false;
  private failure?: Error;
  public push(value: ThreadEvent): void {
    if (this.ended) return;
    if (this.values.length >= MAX_BUFFERED_EVENTS) throw new Error("Codex event buffer limit exceeded");
    this.values.push(value);
    this.wake?.();
  }
  public end(error?: Error): void {
    if (this.ended) return;
    this.ended = true; this.failure = error; this.wake?.();
  }
  public async *read(): AsyncGenerator<ThreadEvent> {
    while (true) {
      if (this.values.length) { yield this.values.shift()!; continue; }
      if (this.ended) { if (this.failure) throw this.failure; return; }
      await new Promise<void>(resolve => { this.wake = resolve; });
      this.wake = undefined;
    }
  }
}

function mapItem(raw: ObjectValue): ThreadItem | undefined {
  const id = string(raw.id);
  if (!id) return undefined;
  const status = raw.status === "inProgress" ? "in_progress" : raw.status === "completed" ? "completed" : "failed";
  switch (raw.type) {
    case "agentMessage": return raw.phase === undefined || raw.phase === null || raw.phase === "final_answer"
      ? { id, type: "agent_message", text: string(raw.text) } : undefined;
    case "reasoning": return { id, type: "reasoning", text: [...Array.isArray(raw.summary) ? raw.summary : [],
      ...Array.isArray(raw.content) ? raw.content : []].filter(value => typeof value === "string").join("\n") };
    case "commandExecution": return { id, type: "command_execution", command: string(raw.command), status,
      aggregated_output: string(raw.aggregatedOutput), ...(typeof raw.exitCode === "number" ? { exit_code: raw.exitCode } : {}) };
    case "mcpToolCall": {
      const result = object(raw.result);
      return { id, type: "mcp_tool_call", server: string(raw.server), tool: string(raw.tool), arguments: raw.arguments,
        status, ...(raw.error ? { error: { message: "Codex tool call failed" } } : {}),
        ...(raw.result ? { result: { content: (Array.isArray(result.content) ? result.content : []) as NonNullable<
          Extract<ThreadItem, { type: "mcp_tool_call" }>["result"]>["content"], structured_content: result.structuredContent } } : {}) };
    }
    case "fileChange": return { id, type: "file_change", status: status === "completed" ? "completed" : "failed",
      changes: (Array.isArray(raw.changes) ? raw.changes : []).map(value => {
        const change = object(value); const kind = object(change.kind).type;
        return { path: string(change.path), kind: kind === "add" || kind === "delete" ? kind : "update" };
      }) };
    case "webSearch": return { id, type: "web_search", query: string(raw.query) || string(object(raw.action).query) };
    default: return undefined;
  }
}

class Connection {
  public threadId = "";
  public turnId = "";
  public readonly queue = new EventQueue();
  private nextId = 0;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout> }>();
  private buffer = Buffer.alloc(0);
  private usage: Usage = { ...EMPTY_USAGE };
  private terminal = false;
  private closed = false;
  private closePromise?: Promise<void>;
  private readonly exited: Promise<void>;
  private readonly abort: () => void;

  constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly signal: AbortSignal) {
    this.exited = new Promise(resolve => { child.once("close", () => {
      this.closed = true;
      if (!this.terminal) this.fail(new Error("Codex app-server exited before the turn completed"));
      resolve();
    }); });
    this.abort = () => { this.fail(new Error("Codex app-server turn aborted")); void this.close(); };
    signal.addEventListener("abort", this.abort, { once: true });
    child.once("error", () => { this.fail(new Error("Codex app-server process failed")); void this.close(); });
    child.stdin.on("error", () => { this.fail(new Error("Codex app-server input failed")); void this.close(); });
    child.stderr.resume(); // Native stderr can contain secrets; it never crosses the transport boundary.
    child.stdout.on("data", (data: Buffer) => {
      try { this.consume(data); }
      catch { this.fail(new Error("Invalid Codex app-server stream")); void this.close(); }
    });
    if (signal.aborted) this.abort();
  }

  private fail(error: Error): void {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
    this.queue.end(error);
  }

  public send(value: unknown): void { this.child.stdin.write(`${JSON.stringify(value)}\n`); }

  public rpc(method: string, params: unknown): Promise<unknown> {
    if (this.closed || this.closePromise || this.signal.aborted) return Promise.reject(new Error("Codex app-server is closed"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Codex app-server request timed out"));
        this.fail(new Error("Codex app-server request timed out"));
        void this.close();
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch { this.pending.delete(id); clearTimeout(timer); reject(new Error("Codex app-server input failed")); }
    });
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let newline: number;
    while ((newline = this.buffer.indexOf(10)) !== -1) {
      if (newline > MAX_FRAME_BYTES) throw new Error("Frame limit exceeded");
      const line = this.buffer.subarray(0, newline).toString("utf8").trim();
      this.buffer = this.buffer.subarray(newline + 1);
      if (line) this.receive(object(JSON.parse(line)));
    }
    if (this.buffer.length > MAX_FRAME_BYTES) throw new Error("Frame limit exceeded");
  }

  private receive(message: ObjectValue): void {
    if (typeof message.id === "number" && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(new AppServerRejectedError(number(object(message.error).code)));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      // Headless execution cannot approve interactive requests. Explicit denial prevents a hung native turn.
      this.send({ id: message.id, error: { code: -32601, message: "Interactive requests are unavailable" } });
      return;
    }
    const params = object(message.params);
    if (this.threadId && params.threadId && params.threadId !== this.threadId) return;
    if (this.turnId && params.turnId && params.turnId !== this.turnId) return;
    switch (message.method) {
      case "thread/tokenUsage/updated": {
        const last = object(object(params.tokenUsage).last);
        this.usage = { input_tokens: number(last.inputTokens), cached_input_tokens: number(last.cachedInputTokens),
          cache_write_input_tokens: number(last.cacheWriteInputTokens), output_tokens: number(last.outputTokens),
          reasoning_output_tokens: number(last.reasoningOutputTokens) };
        break;
      }
      case "item/started":
      case "item/completed": {
        const item = mapItem(object(params.item));
        if (item) this.queue.push({ type: message.method === "item/started" ? "item.started" : "item.completed", item });
        break;
      }
      case "turn/completed": {
        const turn = object(params.turn);
        if (this.turnId && turn.id !== this.turnId) return;
        this.terminal = true;
        this.queue.push(turn.status === "completed" ? { type: "turn.completed", usage: this.usage }
          : { type: "turn.failed", error: { message: "Codex app-server turn did not complete" } });
        this.queue.end();
        break;
      }
      case "error":
        if (params.willRetry !== true) {
          this.fail(new Error("Codex app-server turn failed"));
          void this.close();
        }
        break;
    }
  }

  public close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      this.signal.removeEventListener("abort", this.abort);
      if (!this.closed) {
        this.fail(new Error("Codex app-server connection closed"));
        this.child.stdin.end();
        this.child.kill("SIGTERM");
        const timer = setTimeout(() => {
          if (this.closed) return;
          this.child.kill("SIGKILL");
          // Descendant tools can inherit stdio. Closing our pipe ends prevents them retaining the transport forever.
          this.child.stdin.destroy(); this.child.stdout.destroy(); this.child.stderr.destroy();
        }, EXIT_GRACE_MS);
        try { await this.exited; } finally { clearTimeout(timer); }
      }
    })();
    return this.closePromise;
  }
}

/** One isolated native process owns one query, including all its steered input. */
export async function startAppServerTurn(options: CodexOptions, threadOptions: ThreadOptions,
  threadId: string | undefined, input: string, signal: AbortSignal,
  onThreadStarted?: ThreadStartedHandler): Promise<AppServerTurn> {
  if (signal.aborted) throw new Error("Codex app-server turn aborted");
  const native = binary(options);
  const config = { ...options.config,
    ...(threadOptions.modelReasoningEffort ? { model_reasoning_effort: threadOptions.modelReasoningEffort } : {}),
    ...(threadOptions.webSearchMode ? { web_search: threadOptions.webSearchMode } : {}),
    ...(threadOptions.webSearchEnabled !== undefined && !threadOptions.webSearchMode
      ? { web_search: threadOptions.webSearchEnabled ? "live" : "disabled" } : {}) };
  const args = ["app-server", "--listen", "stdio://"];
  for (const [key, value] of Object.entries(config)) args.push("-c", `${key}=${toml(value)}`);
  for (const override of options.configOverrides ?? []) args.push("-c", override);
  const env = Object.fromEntries(Object.entries(options.env ?? {}).filter(([key]) => ENV_ALLOWLIST.has(key)));
  if (options.apiKey) env.CODEX_API_KEY = options.apiKey;
  if (options.baseUrl) env.OPENAI_BASE_URL = options.baseUrl;
  if (native.pathDirectory && existsSync(native.pathDirectory)) env.PATH = `${native.pathDirectory}${path.delimiter}${env.PATH ?? ""}`;
  const connection = new Connection(spawn(native.executable, args, { env, stdio: "pipe" }), signal);
  try {
    await connection.rpc("initialize", { clientInfo: { name: "wechat_gateway", version: "1.0.0" },
      capabilities: { experimentalApi: true } });
    connection.send({ method: "initialized" });
    const threadParams = { ...(threadOptions.model ? { model: threadOptions.model } : {}),
      ...(threadOptions.workingDirectory ? { cwd: threadOptions.workingDirectory } : {}),
      ...(threadOptions.approvalPolicy ? { approvalPolicy: threadOptions.approvalPolicy } : {}),
      // Named permissions are resolved from native config; a legacy sandbox override would replace them.
      ...(!options.config?.default_permissions && threadOptions.sandboxMode ? { sandbox: threadOptions.sandboxMode } : {}),
      ...(threadOptions.threadSource ? { threadSource: threadOptions.threadSource } : {}) };
    const response = object(await connection.rpc(threadId ? "thread/resume" : "thread/start",
      { ...threadParams, ...(threadId ? { threadId, excludeTurns: true } : {}) }));
    connection.threadId = string(object(response.thread).id);
    if (!connection.threadId) throw new Error("Codex app-server returned no thread ID");
    await onThreadStarted?.(connection.threadId);
    connection.queue.push({ type: "thread.started", thread_id: connection.threadId });
    connection.queue.push({ type: "turn.started" });
    const started = object(await connection.rpc("turn/start", { threadId: connection.threadId,
      input: [{ type: "text", text: input, text_elements: [] }] }));
    connection.turnId = string(object(started.turn).id);
    if (!connection.turnId) throw new Error("Codex app-server returned no turn ID");
    return { threadId: connection.threadId, turnId: connection.turnId,
      events: { async *[Symbol.asyncIterator]() {
        let drained = false;
        try { yield* connection.queue.read(); drained = true; }
        finally { if (!drained) await connection.close(); }
      } },
      async steer(text, expectedTurnId) {
        if (expectedTurnId !== connection.turnId) throw new AppServerRejectedError(-32602);
        const accepted = object(await connection.rpc("turn/steer", { threadId: connection.threadId, expectedTurnId,
          input: [{ type: "text", text, text_elements: [] }] }));
        if (accepted.turnId !== expectedTurnId) throw new Error("Codex app-server steer receipt did not match the active turn");
      }, close: () => connection.close() };
  } catch (error) { await connection.close(); throw error; }
}
