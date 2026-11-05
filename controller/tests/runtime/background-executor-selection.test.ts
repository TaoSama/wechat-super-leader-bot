import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BackgroundExecution } from "../../src/runtime/background.js";
import { ClaudeCliExecutor } from "../../src/background/worker/index.js";
import { CodexCliExecutor } from "../../src/background/worker/executor.js";
import { MemoryStore } from "../../src/store/memory.js";
import { NodeHub } from "../../src/nodes/hub.js";
import type { AutomationRepository } from "../../src/automations/contracts.js";
import type { BackgroundConfig } from "../../src/runtime/background-config.js";
import type { Config } from "../../src/runtime/config.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function executorFor(background: Partial<BackgroundConfig>): unknown {
  const root = mkdtempSync(join(tmpdir(), "background-executor-")); roots.push(root);
  const config: Config = { port: 8790, host: "127.0.0.1", controllerToken: "fixture", nodeTokens: {}, tokenToNode: new Map(),
    allowedChatIds: new Set(), persistenceMode: "memory", commandTtlSeconds: 300,
    background: { executorKind: "codex", root: join(root, "workers"), artifactRoot: join(root, "artifacts"), model: "fixture",
      apiKey: "fixture", baseUrl: "http://127.0.0.1", codexPath: "unused", timeoutMs: 300_000, maxConcurrent: 2, ...background } };
  const execution = new BackgroundExecution(config, {} as AutomationRepository, new NodeHub(new MemoryStore(), config.tokenToNode));
  return (execution as unknown as { runtime: { executor: unknown } }).runtime.executor;
}

describe("background executor selection", () => {
  it("keeps Codex unless Claude is configured", () => {
    expect(executorFor({})).toBeInstanceOf(CodexCliExecutor);
    expect(executorFor({ executorKind: "claude", claude: { path: "claude", apiKey: "key" } })).toBeInstanceOf(ClaudeCliExecutor);
  });
});
