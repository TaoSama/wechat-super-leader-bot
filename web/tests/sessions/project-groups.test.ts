import { describe, expect, it } from "vitest";
import type { ScopedSession } from "../../src/types";
import { groupSessionProjects } from "../../src/features/sessions/project-groups";

function session(id: string, overrides: Partial<ScopedSession> = {}): ScopedSession {
  return {
    id, nodeId: "demoair", provider: "codex-app", title: id, cwd: "/workspace/project",
    status: "idle", capabilities: ["read"], observedAt: "2026-10-22T15:00:00Z",
    ...overrides,
  };
}

describe("project session groups", () => {
  it("groups full workspace paths per machine after normalizing separators and trailing slashes", () => {
    const sessions = [
      session("first", { cwd: "C:\\work\\project\\" }),
      session("second", { cwd: "C:/work/project///" }),
      session("other-machine", { cwd: "C:/work/project", nodeId: "demomini" }),
      session("same-name", { cwd: "C:/another/project" }),
    ];
    const before = structuredClone(sessions);
    const groups = groupSessionProjects(sessions);

    expect(groups.map(group => [group.name, group.path, group.nodeId, group.sessions.map(item => item.id)])).toEqual([
      ["project", "C:/work/project", "demoair", ["first", "second"]],
      ["project", "C:/work/project", "demomini", ["other-machine"]],
      ["project", "C:/another/project", "demoair", ["same-name"]],
    ]);
    expect(new Set(groups.map(group => group.key)).size).toBe(3);
    expect(groups[0].key).toBe(JSON.stringify(["demoair", "C:/work/project"]));
    expect(sessions).toEqual(before);
    expect(groups[0].sessions[0]).toBe(sessions[0]);
  });

  it("keeps empty directories explicit and distinct from the root directory", () => {
    const groups = groupSessionProjects([
      session("unattached", { cwd: "" }),
      session("root", { cwd: "/" }),
      session("root-with-slashes", { cwd: "///" }),
    ]);
    expect(groups.map(group => [group.name, group.path, group.sessions.map(item => item.id)])).toEqual([
      ["未关联 Project", "", ["unattached"]],
      ["/", "/", ["root", "root-with-slashes"]],
    ]);
  });

  it("ranks projects by their newest task and tasks by actual update timestamps", () => {
    const groups = groupSessionProjects([
      session("a-older", { cwd: "/a", updatedAt: "2026-10-22T18:00:00+08:00" }),
      session("b-middle", { cwd: "/b", updatedAt: "2026-10-22T10:30:00Z" }),
      session("a-newest", { cwd: "/a", updatedAt: "2026-10-22T19:00:00+08:00" }),
      session("z-oldest", { cwd: "/z", updatedAt: "2026-10-21T23:00:00Z" }),
    ]);
    expect(groups.map(group => group.name)).toEqual(["a", "b", "z"]);
    expect(groups[0].sessions.map(item => item.id)).toEqual(["a-newest", "a-older"]);
  });

  it("puts missing and invalid update times last without using observation timestamps", () => {
    const groups = groupSessionProjects([
      session("missing", { cwd: "/missing", observedAt: "2099-01-01T00:00:00Z" }),
      session("invalid", { cwd: "/invalid", updatedAt: "invalid", observedAt: "2099-01-02T00:00:00Z" }),
      session("dated-missing", { cwd: "/dated", observedAt: "2099-01-03T00:00:00Z" }),
      session("dated-invalid", { cwd: "/dated", updatedAt: "invalid" }),
      session("dated-old", { cwd: "/dated", updatedAt: "1960-01-01T00:00:00Z" }),
      session("dated-new", { cwd: "/dated", updatedAt: "2026-10-22T10:00:00Z" }),
    ]);
    expect(groups.map(group => group.name)).toEqual(["dated", "missing", "invalid"]);
    expect(groups[0].sessions.map(item => item.id)).toEqual([
      "dated-new", "dated-old", "dated-missing", "dated-invalid",
    ]);
  });

  it("preserves input order for tied project and task timestamps", () => {
    const updatedAt = "2026-10-22T10:00:00Z";
    const groups = groupSessionProjects([
      session("z-first", { cwd: "/z", updatedAt }),
      session("a-second", { cwd: "/a", updatedAt }),
      session("z-third", { cwd: "/z", updatedAt }),
    ]);
    expect(groups.map(group => group.name)).toEqual(["z", "a"]);
    expect(groups[0].sessions.map(item => item.id)).toEqual(["z-first", "z-third"]);
  });

  it("returns no groups for an empty directory", () => {
    expect(groupSessionProjects([])).toEqual([]);
  });

  it("merges the main checkout with managed worktrees of the same repository", () => {
    const groups = groupSessionProjects([
      session("main", { cwd: "/Users/demo/Workspaces/wechat-super-leader-bot" }),
      session("codex-worktree", { cwd: "/Users/demo/.codex/worktrees/6a1b/wechat-super-leader-bot" }),
      session("claude-worktree", { cwd: "/Users/demo/Workspaces/wechat-super-leader-bot/.claude/worktrees/review" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe("wechat-super-leader-bot");
    expect(groups[0].sessions.map(item => item.id)).toEqual(["main", "codex-worktree", "claude-worktree"]);
    expect(groups[0].path).toBe("/Users/demo/Workspaces/wechat-super-leader-bot");
  });
});
