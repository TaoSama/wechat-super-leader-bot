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
    // Codex worktrees use worktrees/<instance>/<repository>. The session cwd
    // may point below the checkout, so use the repository segment instead of
    // treating a nested directory as another project.
    return parts[worktreeIndex + 2] || null;
  }
  if (worktreeIndex >= 0 && parts.length === worktreeIndex + 2 && parts[worktreeIndex - 1] === ".codex") {
    return parts[worktreeIndex + 1] || null;
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
  const worktreeNames = new Set(normalized.flatMap(item => item.worktreeName ? [JSON.stringify([item.session.nodeId, item.worktreeName])] : []));
  const mainPathsByProject = new Map<string, Set<string>>();
  for (const { session, path, worktreeName } of normalized) {
    if (worktreeName !== null) continue;
    const basename = path === "/" ? path : path ? projectName(path) : "未关联 Project";
    const key = JSON.stringify([session.nodeId, basename]);
    const paths = mainPathsByProject.get(key) ?? new Set<string>();
    paths.add(path);
    mainPathsByProject.set(key, paths);
  }
  const groups = new Map<string, SessionProjectGroup>();
  for (const { session, path, worktreeName } of normalized) {
    const basename = path === "/" ? path : path ? projectName(path) : "未关联 Project";
    // A managed worktree is another checkout of the same repository. Its cwd
    // is an implementation detail and must not create a second project card.
    const projectKey = JSON.stringify([session.nodeId, worktreeName ?? basename]);
    const mainPaths = mainPathsByProject.get(projectKey);
    const ambiguousMain = mainPaths !== undefined && mainPaths.size > 1;
    // A worktree path does not identify which same-named main checkout it came
    // from. Keep it isolated when that association would otherwise be guesswork.
    const canonicalName = ambiguousMain ? null : worktreeName ?? (worktreeNames.has(projectKey) ? basename : null);
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
