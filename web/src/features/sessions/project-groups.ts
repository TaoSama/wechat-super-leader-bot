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

function updatedAt(session: ScopedSession): number {
  const timestamp = Date.parse(session.updatedAt ?? "");
  return Number.isFinite(timestamp) ? timestamp : -Infinity;
}

/** Workspace identity includes the full path and machine, even when names match. */
export function groupSessionProjects(sessions: readonly ScopedSession[]): SessionProjectGroup[] {
  const groups = new Map<string, SessionProjectGroup>();
  for (const session of sessions) {
    const path = normalizedPath(session.cwd);
    const key = JSON.stringify([session.nodeId, path]);
    const group = groups.get(key) ?? {
      key,
      name: path === "/" ? path : path ? projectName(path) : "未关联 Project",
      path,
      nodeId: session.nodeId,
      sessions: [],
    };
    group.sessions.push(session);
    groups.set(key, group);
  }

  const result = [...groups.values()];
  for (const group of result) {
    group.sessions.sort((a, b) => updatedAt(b) - updatedAt(a) || 0);
  }
  return result.sort((a, b) => updatedAt(b.sessions[0]) - updatedAt(a.sessions[0]) || 0);
}
