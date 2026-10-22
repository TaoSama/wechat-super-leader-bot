import { performance } from "node:perf_hooks";
import type { CodexLifecycleEvent, ThreadEvent, ThreadItem } from "@openai/codex-sdk";
import { traceEvent } from "../runtime/telemetry.js";

const MAX_ACTIVE_ITEMS = 128;
const NATIVE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const TOOL_TYPES = new Set<ThreadItem["type"]>(["command_execution", "mcp_tool_call", "web_search", "file_change"]);

/** Only native identifiers and fixed metadata cross the telemetry boundary. */
export function nativeId(value: string): string | undefined {
  return NATIVE_ID.test(value) ? value : undefined;
}

/** Item times are observed SDK wall times, never model TTFT or pure tool/network time. */
export class NativeEventTrace {
  private readonly startedAt = performance.now();
  private readonly active = new Map<string, number>();
  private first = true;
  private firstAgentMessage = true;
  private completedAt?: number;
  private overflow = 0;
  private exitObserved = false;

  constructor() {
    traceEvent("codex.stream.begin", { nativeTurnIdAvailable: false, ttftAvailable: false });
  }

  public get itemsSettled(): boolean { return this.active.size === 0 && this.overflow === 0; }

  public observeProcess(event: CodexLifecycleEvent): void {
    if (event.type === "child_exit") this.exitObserved = true;
    traceEvent(`codex.process.${event.type}`, {
      processElapsedMs: event.elapsedMs, exitCode: event.exitCode, signal: event.signal,
    });
  }

  public observe(event: ThreadEvent): void {
    const now = performance.now();
    if (this.first) {
      this.first = false;
      traceEvent("codex.stream.first_event", { firstEventMs: now - this.startedAt });
    }
    if (this.firstAgentMessage && "item" in event && event.item.type === "agent_message") {
      this.firstAgentMessage = false;
      traceEvent("codex.stream.first_agent_message", { firstAgentMessageMs: now - this.startedAt });
    }
    switch (event.type) {
      case "thread.started":
        traceEvent("codex.thread.started", { threadId: nativeId(event.thread_id) });
        break;
      case "turn.started":
        traceEvent("codex.turn.started");
        break;
      case "item.started": {
        const { item } = event;
        if (!this.active.has(item.id)) {
          if (this.active.size < MAX_ACTIVE_ITEMS) this.active.set(item.id, now);
          else this.overflow++;
        }
        traceEvent("codex.item.started", { itemId: nativeId(item.id), itemType: item.type,
          isTool: TOOL_TYPES.has(item.type) });
        break;
      }
      case "item.completed": {
        const { item } = event;
        const start = this.active.get(item.id);
        this.active.delete(item.id);
        traceEvent("codex.item.completed", { itemId: nativeId(item.id), itemType: item.type,
          isTool: TOOL_TYPES.has(item.type), startObserved: start !== undefined,
          durationMs: start === undefined ? undefined : now - start,
          exitCode: item.type === "command_execution" ? item.exit_code : undefined,
          failed: "status" in item ? item.status === "failed" : item.type === "error" });
        break;
      }
      case "turn.completed":
        this.completedAt = now;
        traceEvent("codex.turn.completed", { durationMs: now - this.startedAt,
          inputTokens: event.usage.input_tokens, cachedInputTokens: event.usage.cached_input_tokens,
          cacheWriteInputTokens: event.usage.cache_write_input_tokens,
          outputTokens: event.usage.output_tokens, reasoningOutputTokens: event.usage.reasoning_output_tokens });
        break;
      case "turn.failed":
      case "error":
        traceEvent("codex.turn.failed", { status: event.type });
        break;
    }
  }

  /** Process callbacks provide exit/stdio/cleanup boundaries when the runner supports them. */
  public finish(drained: boolean): void {
    traceEvent(drained ? "codex.stream.drained" : "codex.stream.interrupted", {
      durationMs: performance.now() - this.startedAt,
      streamDrainMs: this.completedAt === undefined ? undefined : performance.now() - this.completedAt,
      turnCompletedObserved: this.completedAt !== undefined, firstEventObserved: !this.first,
      pendingItems: this.active.size, untrackedItemStarts: this.overflow,
      cliExitTimeAvailable: this.exitObserved,
    });
    this.active.clear();
  }
}
