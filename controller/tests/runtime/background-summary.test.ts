import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandService } from "../../src/commands/service.js";
import { RESULT_MESSAGE_CHARS, RESULT_TEXT_MESSAGE_LIMIT, type ResultInput } from "../../src/deliveries/contracts.js";
import type { LeaderModel } from "../../src/leader/model/contracts.js";
import { NodeHub } from "../../src/nodes/hub.js";
import { loadBackgroundConfig } from "../../src/runtime/background-config.js";
import type { Config } from "../../src/runtime/config.js";
import { TaskNotifications } from "../../src/runtime/task-notifications.js";
import { MemoryStore } from "../../src/store/memory.js";

const NOW = Date.parse("2026-10-23T00:00:00Z");
const CHAT = "background-summary";
const PROVIDER_ORIGIN = "https://background.example.test/v1";
const PROVIDER_MODEL = "independent-background-model";
const PROVIDER_KEY = "independent-background-key";
const SUMMARY = "结果已整理，其中一项验证失败。完整证据见成果文件。";
const LONG_RESULT = "实际结果与失败证据。".repeat(RESULT_MESSAGE_CHARS * RESULT_TEXT_MESSAGE_LIMIT);
const roots: string[] = [];
const runtimes: TaskNotifications[] = [];

afterEach(async () => {
  try { await Promise.all(runtimes.splice(0).map(runtime => runtime.stop())); }
  finally {
    vi.unstubAllGlobals();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  }
});

function fixture(options: { model?: LeaderModel; fileMaxBytes?: number; background?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "background-summary-"));
  roots.push(root);
  const config: Config = {
    port: 8790, host: "127.0.0.1", controllerToken: "fixture", nodeTokens: {}, tokenToNode: new Map(),
    allowedChatIds: new Set([CHAT]), persistenceMode: "memory", commandTtlSeconds: 300,
    taskNotifications: { fileMaxBytes: options.fileMaxBytes ?? Buffer.byteLength(LONG_RESULT) + 1,
      retentionMs: 86_400_000, tickMs: 5_000 },
    ...(options.background === false ? {} : { background: loadBackgroundConfig({
      BACKGROUND_WORKER_ROOT: join(root, "workers"), BACKGROUND_ARTIFACT_ROOT: join(root, "artifacts"),
      BACKGROUND_MODEL_BASE_URL: PROVIDER_ORIGIN, BACKGROUND_MODEL_NAME: PROVIDER_MODEL, BACKGROUND_MODEL_API_KEY: PROVIDER_KEY,
      // A background turn budget must not be passed to the HTTP summary client's shorter timeout option.
      BACKGROUND_TURN_TIMEOUT_MS: "3600000",
    }) }),
  };
  const store = new MemoryStore();
  const hub = new NodeHub(store, config.tokenToNode);
  const runtime = new TaskNotifications(config, store, hub, new CommandService(store, hub, 300), options.model, () => NOW, vi.fn());
  runtimes.push(runtime);
  return { config, runtime };
}

function input(text: string): ResultInput {
  return { key: randomUUID(), chatId: CHAT, source: { type: "automation", id: randomUUID() }, kind: "failed", text,
    createdAt: NOW, expiresAt: NOW + 86_400_000 };
}

function response() {
  return Response.json({ status: "completed", output: [{ type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: SUMMARY }] }] });
}

describe("background result summaries with rules mode", () => {
  it.each(["attachment", "download"] as const)("uses the independent provider for a complete %s delivery", async mode => {
    const fetchModel = vi.fn<typeof fetch>().mockImplementation(async () => response());
    vi.stubGlobal("fetch", fetchModel);
    const { runtime, config } = fixture({ fileMaxBytes: mode === "download" ? 1 : undefined });
    expect(config.leader).toBeUndefined();
    const request = input(LONG_RESULT);
    const plan = await runtime.results.prepareResult(request);
    expect(plan).toMatchObject({ status: "ready", mode, kind: "failed", messages: [SUMMARY] });
    expect(fetchModel).toHaveBeenCalledTimes(1);
    const [endpoint, init] = fetchModel.mock.calls[0];
    expect(endpoint).toBe(`${PROVIDER_ORIGIN}/responses`);
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${PROVIDER_KEY}` });
    const payload = JSON.parse(String(init?.body));
    expect(payload).toMatchObject({ model: PROVIDER_MODEL, tools: [], store: false });
    expect(payload.input[1].content).toContain('"kind":"failed"');
    expect((await runtime.results.repository.getArtifact(plan.artifact.id))?.bytes.equals(Buffer.from(LONG_RESULT))).toBe(true);
    expect(await runtime.results.repository.listPending([CHAT], NOW)).toHaveLength(1);
    const materialized = await runtime.results.materialize(plan.id);
    expect(materialized?.messages[0]).toBe(SUMMARY);
    expect(materialized?.artifact.downloadUrl).toContain(`/v1/result-artifacts/${plan.artifact.id}/download?`);
    if (mode === "download") expect(materialized?.messages[1]).toContain(materialized!.artifact.downloadUrl);
    expect((await runtime.results.prepareResult(request)).id).toBe(plan.id);
    expect((await runtime.results.retryPreparation(plan.id))?.status).toBe("ready");
    expect(fetchModel).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])("delivers short results without calling a provider (background=%s)", async background => {
    const fetchModel = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchModel);
    const { runtime } = fixture({ background });
    const plan = await runtime.results.prepareResult(input("任务未完成，请检查配置。"));
    expect(plan).toMatchObject({ status: "ready", mode: "text", messages: ["任务未完成，请检查配置。"] });
    expect((await runtime.results.materialize(plan.id))?.status).toBe("ready");
    expect(fetchModel).not.toHaveBeenCalled();
  });

  it("preserves the supplied chat model as the preferred summary provider", async () => {
    const fetchModel = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchModel);
    const complete = vi.fn(async () => ({ content: SUMMARY, toolCalls: [] }));
    const { runtime } = fixture({ model: { complete } });
    expect((await runtime.results.prepareResult(input(LONG_RESULT))).status).toBe("ready");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(fetchModel).not.toHaveBeenCalled();
  });

  it("retries a failed summary from the retained result without exposing provider error data", async () => {
    const fetchModel = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error: { message: PROVIDER_KEY } }, { status: 400 }))
      .mockImplementation(async () => response());
    vi.stubGlobal("fetch", fetchModel);
    const { runtime } = fixture();
    const plan = await runtime.results.prepareResult(input(LONG_RESULT));
    expect(plan).toMatchObject({ status: "preparing", error: "summary_generation_failed" });
    expect(JSON.stringify(plan)).not.toContain(PROVIDER_KEY);
    expect(await runtime.results.materialize(plan.id)).toBeNull();
    expect(await runtime.results.retryPreparation(plan.id)).toMatchObject({ status: "ready", messages: [SUMMARY] });
    expect(fetchModel).toHaveBeenCalledTimes(2);
    expect((await runtime.results.repository.getArtifact(plan.artifact.id))?.bytes.toString("utf8")).toBe(LONG_RESULT);
  });
});
