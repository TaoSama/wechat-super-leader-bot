import { describe, expect, it, vi } from "vitest";
import { DesktopObservationSchema, SessionSchema } from "../../src/types.js";
import type { DesktopObservation, ScopedSession, Session } from "../../src/types.js";
import { MAX_MODEL_METADATA_BYTES, sanitizeModelMetadata } from "../../src/sessions/model-metadata.js";
import { MAX_DESKTOP_OBSERVATION_AGE_MS, selectExecutionObservation, selectModelObservation } from "../../src/sessions/observation.js";
import { selectSendRoute } from "../../src/sessions/send-eligibility.js";
import { LeaderOrchestrator } from "../../src/leader/orchestrator.js";
import { LEADER_TOOLS, SYSTEM_PROMPT } from "../../src/leader/contracts.js";
import { MemoryStore } from "../../src/store/memory.js";
import type { LeaderModel } from "../../src/leader/model/contracts.js";

const NOW = Date.parse("2026-10-11T12:00:00.000Z");
const iso = (offset = 0) => new Date(NOW + offset).toISOString();
const desktop = (overrides: Partial<DesktopObservation> = {}): DesktopObservation => ({
  source: "codex-desktop", status: "active", availability: "available", observedAt: iso(),
  model: "desktop-model", modelProvider: "desktop-provider", reasoningEffort: "ultra", ...overrides,
});
const session = (overrides: Partial<Session> = {}): Session => ({
  id: "session", title: "fixture", cwd: "/fixture", provider: "codex-app", status: "notLoaded", capabilities: ["read"],
  loaded: false, observedAt: iso(-1000), model: "native-model", modelProvider: "native-provider", reasoningEffort: "high", ...overrides,
});
const invalidMetadata: unknown[] = [undefined, null, 12, false, {}, [], "", " padded", "padded ", "\tmodel", "model\n",
  "model\u0000", "model\u007f", "model\u0085", "model\ufffd", "model\ud800", "model\udfff", "x".repeat(257), "é".repeat(129)];

describe("model metadata boundary", () => {
  it("accepts exact UTF-8 limits and valid surrogate pairs without trimming", () => {
    for (const value of ["model", "模型", "x".repeat(MAX_MODEL_METADATA_BYTES), "é".repeat(128), "😀".repeat(64)]) {
      expect(sanitizeModelMetadata(value)).toBe(value);
    }
  });

  it.each(invalidMetadata)("omits invalid optional metadata while preserving valid status %#", value => {
    const raw = { ...desktop(), model: value, modelProvider: value, reasoningEffort: value };
    const original = structuredClone(raw);
    const parsed = DesktopObservationSchema.parse(raw);
    expect(parsed).toEqual({ source: "codex-desktop", status: "active", availability: "available", observedAt: iso() });
    expect(SessionSchema.parse(session({ desktopObservation: raw as DesktopObservation }))).toMatchObject({ desktopObservation: parsed });
    expect(raw).toEqual(original);
    expect(sanitizeModelMetadata(value)).toBeUndefined();
  });

  it("sanitizes each field independently and still rejects invalid mandatory observation facts", () => {
    expect(DesktopObservationSchema.parse({ ...desktop(), modelProvider: 12, reasoningEffort: " bad" })).toEqual({
      source: "codex-desktop", status: "active", availability: "available", observedAt: iso(), model: "desktop-model",
    });
    for (const overrides of [{ source: "other" }, { availability: "other" }, { status: "other" }, { observedAt: "invalid" }]) {
      expect(DesktopObservationSchema.safeParse({ ...desktop(), ...overrides }).success).toBe(false);
    }
  });
});

describe("one-source model observations", () => {
  it("prefers fresh available desktop even when native is unloaded or desktop status is unknown", () => {
    const raw = session({ desktopObservation: desktop({ status: "unknown" }) });
    const original = structuredClone(raw);
    expect(selectModelObservation(raw, NOW)).toEqual({ source: "codex-desktop", observedAt: iso(),
      model: "desktop-model", modelProvider: "desktop-provider", reasoningEffort: "ultra" });
    expect(raw).toEqual(original);
    expect(selectExecutionObservation(raw, NOW).executionStatus).toBe("notLoaded");
  });

  it("never fills a desktop group using native provider or effort", () => {
    const raw = session({ desktopObservation: desktop({ modelProvider: undefined, reasoningEffort: undefined }) });
    expect(selectModelObservation(raw, NOW)).toEqual({ source: "codex-desktop", observedAt: iso(), model: "desktop-model" });
    expect(selectModelObservation(session({ desktopObservation: desktop({ modelProvider: " bad", reasoningEffort: "" }) }), NOW)).toEqual({
      source: "codex-desktop", observedAt: iso(), model: "desktop-model",
    });
  });

  it.each([
    { observedAt: iso(-MAX_DESKTOP_OBSERVATION_AGE_MS - 1) }, { observedAt: iso(1) }, { observedAt: undefined },
    { observedAt: "now" }, { observedAt: "2026-02-30T12:00:00Z" }, { observedAt: "2026-10-11T24:00:00Z" },
    { availability: "unavailable" }, { source: "other" }, { model: "" }, { model: " invalid" }, { model: 12 },
  ])("falls back to a complete native group for unusable desktop observations %#", overrides => {
    const raw = session({ desktopObservation: { ...desktop(), ...overrides } as DesktopObservation });
    expect(selectModelObservation(raw, NOW)).toEqual({ source: "control-socket", observedAt: iso(-1000),
      model: "native-model", modelProvider: "native-provider", reasoningEffort: "high" });
  });

  it("accepts the exact desktop age boundary and rejects non-finite clocks", () => {
    const raw = session({ desktopObservation: desktop({ observedAt: iso(-MAX_DESKTOP_OBSERVATION_AGE_MS) }) });
    expect(selectModelObservation(raw, NOW).source).toBe("codex-desktop");
    expect(selectModelObservation(raw, Number.NaN).source).toBe("control-socket");
  });

  it("does not require native freshness but omits malformed native timestamps or metadata", () => {
    expect(selectModelObservation(session({ observedAt: iso(-90000) }), NOW)).toEqual({ source: "control-socket", observedAt: iso(-90000),
      model: "native-model", modelProvider: "native-provider", reasoningEffort: "high" });
    expect(selectModelObservation(session({ observedAt: "now", modelProvider: " invalid", reasoningEffort: "" }), NOW)).toEqual({
      source: "control-socket", model: "native-model",
    });
  });

  it("returns unknown without residual metadata if neither source has a valid model", () => {
    for (const model of [undefined, "", " padded", "model\u0000"]) {
      expect(selectModelObservation(session({ model, desktopObservation: desktop({ model: undefined }) }), NOW)).toEqual({ source: "unknown" });
    }
  });

  it("does not alter execution or send qualification, including malformed optional model metadata", () => {
    const availability: NonNullable<Session["sendAvailability"]> = { route: "desktop-owner", state: "ready", observedAt: iso(), validUntil: iso(45000) };
    for (const status of ["idle", "active", "unknown"] as const) {
      const base = session({ desktopObservation: desktop({ status }), sendAvailability: availability });
      const malformed = { ...base, desktopObservation: { ...base.desktopObservation!, model: {}, modelProvider: 12, reasoningEffort: " padded" } } as unknown as Session;
      const parsed = SessionSchema.parse(malformed);
      expect(selectSendRoute(malformed, NOW)).toEqual(selectSendRoute(base, NOW));
      expect(selectSendRoute(parsed, NOW)).toEqual(selectSendRoute(base, NOW));
      expect(selectExecutionObservation(parsed, NOW)).toEqual(selectExecutionObservation(base, NOW));
      selectModelObservation(parsed, NOW);
      expect(parsed).toMatchObject({ status: "notLoaded", loaded: false, capabilities: ["read"], observedAt: iso(-1000),
        model: "native-model", sendAvailability: availability });
    }
    expect(selectSendRoute(session({ desktopObservation: desktop({ status: "idle" }) }), NOW).ready).toBe(false);
  });
});

describe("Leader model views", () => {
  it("preserves raw facts and status filtering while exposing modelView and source instructions without dispatch", async () => {
    const sessions: ScopedSession[] = [
      { ...session({ desktopObservation: desktop() }), nodeId: "node" },
      { ...session({ id: "idle", status: "idle", loaded: true, capabilities: ["read", "send"], desktopObservation: desktop({ status: "idle" }) }), nodeId: "node" },
    ];
    const original = structuredClone(sessions);
    const store = new MemoryStore();
    const commands = { submit: vi.fn() };
    const hub = { getAllSessions: async () => sessions, getNodeStatusList: () => [], getAllSkills: () => [], getNodeSkills: () => [],
      getNodeSession: () => null, isNodeConnected: () => true };
    let calls = 0;
    let output: { sessions: (ScopedSession & { modelView: unknown })[]; snapshot: Record<string, unknown> } | undefined;
    const model: LeaderModel = { complete: async (messages, tools) => {
      expect(messages.find(item => item.role === "system")?.content).toBe(SYSTEM_PROMPT);
      expect(SYSTEM_PROMPT).toContain("list_sessions.modelView");
      expect(tools).toEqual(LEADER_TOOLS);
      expect(tools.find(item => item.function.name === "list_sessions")?.function.description).toContain("回答模型使用 modelView");
      if (++calls === 1) return { content: null, toolCalls: [{ id: "query", type: "function", function: { name: "list_sessions", arguments: '{"status":"active"}' } }] };
      output = JSON.parse(messages.find(item => item.role === "tool")!.content!);
      return { content: "桌面观测模型为 desktop-model。", toolCalls: [] };
    } };
    await new LeaderOrchestrator(store, hub, commands, model, () => NOW).handle("chat", "query", "列出 active 会话模型");
    expect(output!.sessions).toHaveLength(1);
    expect(output!.sessions[0]).toMatchObject({ ...sessions[0], executionStatus: "active", statusSource: "codex-desktop",
      modelView: { source: "codex-desktop", model: "desktop-model", modelProvider: "desktop-provider", reasoningEffort: "ultra", observedAt: iso() } });
    expect(output!.sessions[0].model).toBe("native-model");
    expect(output!.snapshot.statusCounts).toEqual({ active: 1, idle: 1 });
    expect(sessions).toEqual(original);
    expect(commands.submit).not.toHaveBeenCalled();
    expect(await store.listRecentCommands()).toEqual([]);
  });
});
