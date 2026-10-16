import { emptyGoals, emptyExecutions  } from "../fixtures/status-fixtures";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeControlPlaneStatus } from "../../src/api/normalizers";
import { SessionWorkspace } from "../../src/features/sessions/components/SessionWorkspace";
import { sendBlockReason } from "../../src/features/sessions/useSessionMessages";
import { selectModelObservation } from "../../src/features/sessions/model-observation";
import { MAX_MODEL_FIELD_BYTES, normalizeDesktopObservation, normalizeModelField } from "../../src/features/sessions/session-observation";
import type { DesktopObservation, ScopedSession } from "../../src/types";

const NOW = Date.parse("2026-10-11T15:00:00Z");
const iso = (offset = 0) => new Date(NOW + offset).toISOString();
const desktop = (overrides: Partial<DesktopObservation> = {}): DesktopObservation => ({
  status: "active", source: "codex-desktop", availability: "available", observedAt: iso(),
  model: "desktop-model", modelProvider: "desktop-provider", reasoningEffort: "high", ...overrides,
});
const session = (overrides: Partial<ScopedSession> = {}): ScopedSession => ({
  id: "session", nodeId: "node", provider: "codex-app", title: "原桌面会话", cwd: "/fixture",
  status: "unknown", loaded: false, capabilities: ["read"], observedAt: iso(-1000),
  desktopObservation: desktop(), ...overrides,
});
const nodes = [{ nodeId: "node", connected: true, inferredOffline: false, sessionCount: 1, lastHeartbeat: iso() }];
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("model metadata normalization", () => {
  it.each([undefined, null, true, 1, {}, [], "", " model", "model ", "x\ny", "x\u0000y", "x\uFFFDy", "x\uD800y",
    "x".repeat(MAX_MODEL_FIELD_BYTES + 1), "界".repeat(86)])("omits malformed field without clipping %#", value => {
    expect(normalizeModelField(value)).toBeUndefined();
  });
  it.each(["gpt-6.1-sol", "a".repeat(MAX_MODEL_FIELD_BYTES), "界".repeat(85), "model😀"])("keeps complete valid UTF-8 value %#", value => {
    expect(normalizeModelField(value)).toBe(value);
  });
  it("keeps valid status and permission denial when model metadata is malformed", () => {
    const observation = { ...desktop(), model: {}, reasoningEffort: "x\nprivate", privateField: "private" };
    expect(normalizeDesktopObservation(observation)).toEqual({
      status: "active", source: "codex-desktop", availability: "available", observedAt: iso(), modelProvider: "desktop-provider",
    });
    const raw = { ...session(), desktopObservation: observation };
    const normalized = normalizeControlPlaneStatus({ nodes, sessions: [raw], commands: [], goals: emptyGoals(), executions: emptyExecutions() }).sessions[0];
    expect(normalized.desktopObservation?.status).toBe("active");
    expect(selectModelObservation(normalized, NOW)).toEqual({ source: "unknown" });
    expect(sendBlockReason(normalized, true, false, NOW)).not.toBeNull();
  });
});

describe("model observation selection", () => {
  it("prefers fresh desktop settings as one group without mutating native facts", () => {
    const raw = session({ model: "native-model", modelProvider: "native-provider", reasoningEffort: "low" });
    const before = structuredClone(raw);
    expect(selectModelObservation(raw, NOW)).toEqual({
      model: "desktop-model", modelProvider: "desktop-provider", reasoningEffort: "high", source: "codex-desktop", observedAt: iso(),
    });
    expect(raw).toEqual(before);
    expect(sendBlockReason(raw, true, false, NOW)).not.toBeNull();
  });
  it("does not fill missing desktop provider or effort from native metadata", () => {
    const raw = session({ model: "native-model", modelProvider: "native-provider", reasoningEffort: "low",
      desktopObservation: desktop({ modelProvider: undefined, reasoningEffort: undefined }) });
    expect(selectModelObservation(raw, NOW)).toEqual({ model: "desktop-model", source: "codex-desktop", observedAt: iso() });
  });
  it.each([
    desktop({ availability: "unavailable" }), desktop({ observedAt: undefined }), desktop({ observedAt: iso(1) }),
    desktop({ observedAt: iso(-45_001) }), desktop({ observedAt: "2026-02-30T12:00:00Z" }),
    desktop({ observedAt: "October 11 2026 15:00:00 GMT" }), desktop({ model: undefined }), desktop({ model: "" }),
    desktop({ model: " model" }), { ...desktop(), source: "other" } as unknown as DesktopObservation,
  ])("falls back to the whole native group for unusable desktop evidence %#", observation => {
    const raw = session({ model: "native-model", desktopObservation: observation });
    expect(selectModelObservation(raw, NOW)).toEqual({ model: "native-model", source: "control-socket", observedAt: iso(-1000) });
    expect(selectModelObservation({ ...raw, model: undefined }, NOW)).toEqual({ source: "unknown" });
  });
  it("accepts the exact desktop TTL boundary, not the following millisecond", () => {
    expect(selectModelObservation(session(), NOW + 45_000).source).toBe("codex-desktop");
    expect(selectModelObservation(session(), NOW + 45_001).source).toBe("unknown");
  });
  it("does not invent a timestamp or model from native provider alone", () => {
    expect(selectModelObservation(session({ desktopObservation: undefined, modelProvider: "provider" }), NOW)).toEqual({ source: "unknown" });
    expect(selectModelObservation(session({ desktopObservation: undefined, model: "native-model", observedAt: "yesterday" }), NOW))
      .toEqual({ model: "native-model", source: "control-socket" });
  });
});

function workspaceData(raw: ScopedSession) { return { nodes, sessions: [raw], commands: [], goals: emptyGoals(), executions: emptyExecutions() }; }

describe("workspace model views", () => {
  it("shows one model group in list, detail and composer, with source and time", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const raw = session({ model: "native-model", modelProvider: "native-provider", reasoningEffort: "low" });
    render(<SessionWorkspace data={workspaceData(raw)} nodes={nodes} stale={false} active={false} onAuthFailure={vi.fn()} />);
    const row = screen.getByTestId("session-row-node-session");
    expect(row.querySelector(".session-model")).toHaveTextContent("desktop-model");
    fireEvent.click(row);
    expect(document.querySelector(".detail-model")).toHaveTextContent("desktop-model");
    expect(document.querySelector(".composer-label span")).toHaveTextContent("desktop-model");
    const details = document.querySelector(".session-metadata") as HTMLElement;
    expect(within(details).getByText("desktop-provider")).toBeInTheDocument();
    expect(within(details).getByText("high")).toBeInTheDocument();
    expect(within(details).getByText("桌面会话设置")).toBeInTheDocument();
    expect(within(details).getByText("模型观测时间").nextElementSibling).toHaveTextContent("2026-10-11");
    expect(screen.getByRole("button", { name: "发送消息" })).toBeDisabled();
    expect(raw.model).toBe("native-model");
  });
  it("searches the displayed model and provider, not shadowed native settings", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    render(<SessionWorkspace data={workspaceData(session({ model: "native-model" }))} nodes={nodes} stale={false} active={false} onAuthFailure={vi.fn()} />);
    const search = screen.getByLabelText("搜索会话");
    for (const value of ["desktop-model", "desktop-provider"]) {
      fireEvent.change(search, { target: { value } });
      expect(screen.getByTestId("session-row-node-session")).toBeInTheDocument();
    }
    fireEvent.change(search, { target: { value: "native-model" } });
    expect(screen.queryByTestId("session-row-node-session")).not.toBeInTheDocument();
  });
  it("expires model and search results with no new heartbeat, then falls back to native", async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const { unmount } = render(<SessionWorkspace data={workspaceData(session({ model: "native-model" }))} nodes={nodes} stale={false} onAuthFailure={vi.fn()} />);
    const search = screen.getByLabelText("搜索会话");
    fireEvent.change(search, { target: { value: "desktop-model" } });
    expect(screen.getByTestId("session-row-node-session")).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(45_001); });
    expect(screen.queryByTestId("session-row-node-session")).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: "native-model" } });
    expect(screen.getByTestId("session-row-node-session")).toHaveTextContent("native-model");
    unmount(); expect(vi.getTimerCount()).toBe(0);
  });
  it("handles a model change and disconnection without retaining stale desktop settings", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const raw = session();
    const props = { nodes, stale: false, active: false, onAuthFailure: vi.fn() };
    const { rerender } = render(<SessionWorkspace {...props} data={workspaceData(raw)} />);
    const row = screen.getByTestId("session-row-node-session");
    expect(row).toHaveTextContent("desktop-model");
    rerender(<SessionWorkspace {...props} data={workspaceData(session({ desktopObservation: desktop({ model: "new-model" }) }))} />);
    expect(row).toHaveTextContent("new-model");
    rerender(<SessionWorkspace {...props} data={workspaceData(session({ desktopObservation: desktop({ availability: "unavailable" }) }))} />);
    expect(row).toHaveTextContent("模型未报告");
    expect(row).not.toHaveTextContent("new-model");
  });
});
