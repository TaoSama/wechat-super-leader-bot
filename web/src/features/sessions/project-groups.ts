import { projectName } from "../../format";
import type { ScopedSession } from "../../types";

export interface SessionProjectGroup {
  key: string;
  name: string;
  path: string;
  nodeId: string;
  sessions: ScopedSession[];
}

function normalizedPath(cwd: string): string {
  const path = cwd.replaceAll("\\", "/");
  return path && /^\/+$/u.test(path) ? "/" : path.replace(/\/+$/u, "");
}

function worktreeProjectName(path: string): string | null {
  const parts = path.split("/").filter(Boolean);
  const claudeIndex = parts.lastIndexOf(".claude");
  if (claudeIndex > 0 && parts[claudeIndex + 1] === "worktrees" && parts.length > claudeIndex + 2) {
    return parts[claudeIndex - 1] || null;
  }
  const worktreeIndex = parts.lastIndexOf("worktrees");
  if (worktreeIndex >= 0 && parts.length > worktreeIndex + 2) {
    return parts.at(-1) || null;
  }
  return null;
}

function updatedAt(session: ScopedSession): number {
  const timestamp = Date.parse(session.updatedAt ?? "");
  return Number.isFinite(timestamp) ? timestamp : -Infinity;
}

/** Workspace identity includes the full path and machine, even when names match. */
export function groupSessionProjects(sessions: readonly ScopedSession[]): SessionProjectGroup[] {
  const normalized = sessions.map(session => ({ session, path: normalizedPath(session.cwd), worktreeName: worktreeProjectName(normalizedPath(session.cwd)) }));
  const worktreeNames = new Set(normalized.flatMap(item => item.worktreeName ? [item.worktreeName] : []));
  const groups = new Map<string, SessionProjectGroup>();
  for (const { session, path, worktreeName } of normalized) {
    const basename = path === "/" ? path : path ? projectName(path) : "未关联 Project";
    // A managed worktree is another checkout of the same repository. Its cwd
    // is an implementation detail and must not create a second project card.
    const canonicalName = worktreeName ?? (worktreeNames.has(basename) ? basename : null);
    const key = canonicalName ? JSON.stringify([session.nodeId, "project", canonicalName]) : JSON.stringify([session.nodeId, path]);
    const group = groups.get(key) ?? {
      key,
      name: canonicalName ?? basename,
      path,
      nodeId: session.nodeId,
      sessions: [],
    };
    if (canonicalName && worktreeName === null && group.path !== path) group.path = path;
    group.sessions.push(session);
    groups.set(key, group);
  }

  const result = [...groups.values()];
  for (const group of result) {
    group.sessions.sort((a, b) => updatedAt(b) - updatedAt(a) || 0);
  }
  return result.sort((a, b) => updatedAt(b.sessions[0]) - updatedAt(a.sessions[0]) || 0);
}
