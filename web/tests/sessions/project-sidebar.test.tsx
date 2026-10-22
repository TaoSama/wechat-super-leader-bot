import { createRef, type ComponentProps } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SessionSidebar } from "../../src/features/sessions/components/SessionSidebar";
import { MAX_DESKTOP_OBSERVATION_AGE_MS } from "../../src/features/sessions/session-observation";
import type { ScopedSession } from "../../src/types";

const NOW = Date.parse("2026-10-22T15:00:00Z");
const iso = (offset = 0) => new Date(NOW + offset).toISOString();

function session(id: string, overrides: Partial<ScopedSession> = {}): ScopedSession {
  return { id, nodeId: "air", provider: "codex-app", title: `任务 ${id}`, cwd: "/work/project",
    status: "idle", capabilities: ["read"], observedAt: iso(), model: "secret-model-v1", ...overrides };
}

function sidebar(sessions: ScopedSession[], overrides: Partial<ComponentProps<typeof SessionSidebar>> = {}) {
  const props: ComponentProps<typeof SessionSidebar> = {
    sessions, nodes: [{ nodeId: "air", connected: true, sessionCount: sessions.length, lastHeartbeat: iso(), inferredOffline: false }],
    now: NOW, selectedKey: null, listRef: createRef<HTMLDivElement>(), onScroll: vi.fn(), onOpen: vi.fn(), ...overrides,
  };
  return { ...render(<SessionSidebar {...props} />), props };
}

describe("project sidebar navigation", () => {
  it("orders projects by their latest task, tasks by update time, and numbers tasks across projects", () => {
    sidebar([
      session("a-old", { cwd: "/a", updatedAt: iso(-3000) }),
      session("b-middle", { cwd: "/b", updatedAt: iso(-1000) }),
      session("z-newest", { cwd: "/z", updatedAt: iso() }),
      session("a-newer", { cwd: "/a", updatedAt: iso(-2000) }),
    ]);
    expect(screen.getAllByRole("region").map(region => region.getAttribute("aria-label"))).toEqual([
      "z（air）", "b（air）", "a（air）",
    ]);
    const rows = screen.getAllByTestId(/^session-row-/);
    expect(rows.map(row => row.getAttribute("title"))).toEqual(["任务 z-newest", "任务 b-middle", "任务 a-newer", "任务 a-old"]);
    rows.forEach((row, index) => expect(within(row).getByText(`${index + 1}.`)).toBeVisible());
    expect(screen.getByText("按最近更新排列")).toBeVisible();
  });

  it("preserves the focused and selected task when polling moves its project in the list", () => {
    const selected = session("selected", { cwd: "/a", updatedAt: iso(-1000) });
    const other = session("other", { cwd: "/b", updatedAt: iso() });
    const key = JSON.stringify([selected.nodeId, selected.id]);
    const { props, rerender } = sidebar([selected, other], { selectedKey: key });
    const row = screen.getByTestId("session-row-air-selected");
    row.focus();
    rerender(<SessionSidebar {...props} sessions={[{ ...selected, updatedAt: iso(1000) }, other]} />);
    expect(screen.getAllByTestId(/^session-row-/)[0]).toBe(row);
    expect(row).toHaveAttribute("aria-pressed", "true");
    expect(row).toHaveFocus();
    expect(within(row).getByText("1.")).toBeVisible();
  });

  it("keeps task rows concise with titles and short status labels without model details", () => {
    sidebar([
      session("working", { status: "active" }), session("waiting", { status: "blocked" }),
      session("idle"), session("unloaded", { status: "notLoaded" }),
    ]);
    for (const [id, label] of [["working", "忙"], ["waiting", "等"], ["idle", "闲"], ["unloaded", "未载"]]) {
      const row = screen.getByTestId(`session-row-air-${id}`);
      expect(within(row).getByText(`任务 ${id}`)).toBeVisible();
      expect(within(row).getByText(label)).toBeVisible();
      expect(row).not.toHaveTextContent(/执行中|需要回复|模型未报告/);
    }
    expect(screen.queryByText("secret-model-v1")).not.toBeInTheDocument();
  });

  it("separates matching project names by full path and machine while showing offline tasks", () => {
    sidebar([
      session("one", { cwd: "/work/one/shared" }),
      session("two", { cwd: "/work/two/shared" }),
      session("remote", { cwd: "/work/one/shared", nodeId: "mini" }),
    ], { nodes: [
      { nodeId: "air", connected: true, sessionCount: 2, lastHeartbeat: iso(), inferredOffline: false },
      { nodeId: "mini", connected: false, sessionCount: 1, lastHeartbeat: iso(-60_000), inferredOffline: true },
    ] });
    const one = screen.getByRole("region", { name: "shared（air · /work/one/shared）" });
    const two = screen.getByRole("region", { name: "shared（air · /work/two/shared）" });
    const remote = screen.getByRole("region", { name: "shared（mini）" });
    expect(within(one).getByText("/work/one/shared")).toBeVisible();
    expect(within(two).getByText("/work/two/shared")).toBeVisible();
    expect(within(remote).getByText("（mini · 离线）")).toBeVisible();
    expect(within(remote).getByRole("button", { name: /任务 remote/ })).toBeVisible();
  });

  it("does not discard sessions whose machine is absent from the node snapshot", () => {
    sidebar([session("orphan", { nodeId: "missing-node" })], { nodes: [] });
    const group = screen.getByRole("region", { name: "project（missing-node）" });
    expect(within(group).getByText("（missing-node · 离线）")).toBeVisible();
    expect(within(group).getByRole("button", { name: /任务 orphan/ })).toBeVisible();
  });

  it("supports collapsing and expanding a project with the keyboard", async () => {
    const user = userEvent.setup();
    sidebar([session("keyboard")]);
    const toggle = screen.getByRole("button", { name: "收起 project（air）" });
    toggle.focus();
    await user.keyboard("{Enter}");
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("session-row-air-keyboard")).not.toBeVisible();
    expect(screen.getByRole("button", { name: "展开 project（air）" })).toBe(toggle);
    await user.keyboard(" ");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("session-row-air-keyboard")).toBeVisible();
  });

  it("reveals search matches inside collapsed projects and restores collapse when search is cleared", async () => {
    const user = userEvent.setup();
    sidebar([session("needle", { title: "查找目标" }), session("other", { cwd: "/other" })]);
    await user.click(screen.getByRole("button", { name: "收起 project（air）" }));
    expect(screen.getByTestId("session-row-air-needle")).not.toBeVisible();
    await user.type(screen.getByRole("textbox", { name: "搜索会话" }), "查找目标");
    expect(screen.getByTestId("session-row-air-needle")).toBeVisible();
    expect(screen.queryByTestId("session-row-air-other")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "收起 project（air）" })).toHaveAttribute("aria-expanded", "true");
    await user.click(screen.getByRole("button", { name: "清除搜索" }));
    expect(screen.getByRole("textbox", { name: "搜索会话" })).toHaveValue("");
    expect(screen.getByRole("textbox", { name: "搜索会话" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "展开 project（air）" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("session-row-air-needle")).not.toBeVisible();
    expect(screen.getByTestId("session-row-air-other")).toBeVisible();
  });

  it("opens the intended machine and session even when another machine uses the same session id", async () => {
    const user = userEvent.setup();
    const key = JSON.stringify(["mini", "same-id"]);
    const { props } = sidebar([
      session("same-id"), session("same-id", { nodeId: "mini" }),
    ], { selectedKey: key });
    const air = screen.getByTestId("session-row-air-same-id");
    const mini = screen.getByTestId("session-row-mini-same-id");
    expect(air).toHaveAttribute("aria-pressed", "false");
    expect(mini).toHaveAttribute("aria-pressed", "true");
    await user.click(mini);
    await user.click(air);
    expect(props.onOpen).toHaveBeenNthCalledWith(1, key);
    expect(props.onOpen).toHaveBeenNthCalledWith(2, JSON.stringify(["air", "same-id"]));
  });

  it("uses fresh desktop execution state only within its validity period", () => {
    const sessions = [session("desktop", { status: "notLoaded", desktopObservation: {
      source: "codex-desktop", availability: "available", status: "active", observedAt: iso(),
    } })];
    const { props, rerender } = sidebar(sessions);
    const row = screen.getByTestId("session-row-air-desktop");
    expect(within(row).getByText("忙")).toBeVisible();
    rerender(<SessionSidebar {...props} now={NOW + MAX_DESKTOP_OBSERVATION_AGE_MS} />);
    expect(within(row).getByText("忙")).toBeVisible();
    rerender(<SessionSidebar {...props} now={NOW + MAX_DESKTOP_OBSERVATION_AGE_MS + 1} />);
    expect(within(row).getByText("未载")).toBeVisible();
    expect(within(row).queryByText("忙")).not.toBeInTheDocument();
    rerender(<SessionSidebar {...props} now={NOW - 1} />);
    expect(within(row).getByText("未载")).toBeVisible();
  });
});
