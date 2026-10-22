import { sessionLabel } from "../plans/presentation.js";

export const MAX_DIRECTORY_CHARS = 15000;
const DIRECTORY_PREFIX = "已观测会话：\n\n";
const DIRECTORY_COVERAGE = "\n\n仅展示在线节点已观测的会话。";
const omissionNotice = (count: number) => count ? `\n\n另有${count}个会话因消息长度限制未展示。` : "";

export interface DirectorySession {
  nodeId: string;
  nodeName?: string;
  id: string;
  title?: string;
  cwd?: string;
  updatedAt?: string;
  executionStatus?: string;
  modelView?: { model?: string };
}

const STATUS_LABELS: Record<string, string> = {
  active: "忙", busy: "忙", running: "忙", idle: "闲", done: "完",
  blocked: "等", notLoaded: "未载", unknown: "未知", error: "错",
};
export const sessionStatusLabel = (status?: string) => STATUS_LABELS[status ?? "unknown"] ?? "未知";

export interface SessionProject {
  name: string;
  path: string;
  machineName: string;
  groupLabel: string;
}

const pathOf = (session: DirectorySession) => {
  const path = (session.cwd ?? "").replaceAll("\\", "/");
  return path && /^\/+$/u.test(path) ? "/" : path.replace(/\/+$/u, "");
};
const updatedAt = (session: DirectorySession) => {
  const timestamp = Date.parse(session.updatedAt ?? "");
  return Number.isFinite(timestamp) ? timestamp : -Infinity;
};

/** Directory identity includes the machine and full workspace path, never just its basename. */
export function groupSessionProjects<T extends DirectorySession>(sessions: T[]) {
  const groups = new Map<string, { project: SessionProject; sessions: T[] }>();
  for (const session of sessions) {
    const path = pathOf(session);
    const name = path ? path.split("/").at(-1) || path : "未关联 Project";
    const machineName = session.nodeName || session.nodeId;
    const key = JSON.stringify([session.nodeId, path]);
    const group = groups.get(key) ?? { project: { name, path, machineName, groupLabel: `${name}（${machineName}）` }, sessions: [] };
    group.sessions.push(session);
    groups.set(key, group);
  }
  const result = [...groups.values()];
  for (const group of result) {
    if (result.some(other => other !== group && other.project.name === group.project.name &&
      other.project.machineName === group.project.machineName)) {
      group.project.groupLabel = `${group.project.name}（${group.project.machineName} · ${group.project.path || "未关联目录"}）`;
    }
    group.sessions.sort((a, b) => updatedAt(b) - updatedAt(a) || 0);
  }
  return result.sort((a, b) => updatedAt(b.sessions[0]) - updatedAt(a.sessions[0]) || 0);
}

export function renderSessionDirectory(sessions: DirectorySession[]): string {
  if (!sessions.length) return "当前筛选范围的已观测快照未发现会话；仅覆盖在线节点已观测的会话。";
  let number = 0;
  const projects = groupSessionProjects(sessions).map(group => {
    const lines = group.sessions.map(session =>
      `${++number}. ${sessionLabel(sessionStatusLabel(session.executionStatus), session.id, session.title)}`);
    // Reuse the title literal escaping so project metadata cannot become transport Markdown.
    const header = sessionLabel("", "", group.project.groupLabel).slice("[] ".length);
    return { header, lines };
  });
  const complete = `${DIRECTORY_PREFIX}${projects.map(project => `${project.header}\n${project.lines.join("\n")}`).join("\n\n")}${DIRECTORY_COVERAGE}`;
  if (complete.length <= MAX_DIRECTORY_CHARS) return complete;
  let directory = "";
  let shownCount = 0;
  // Reserve the omission notice before accepting a whole session, including its project header.
  for (const project of projects) {
    for (let index = 0; index < project.lines.length; index++) {
      const prefix = index === 0 ? `${directory ? "\n\n" : ""}${project.header}\n` : "\n";
      const candidate = `${directory}${prefix}${project.lines[index]}`;
      const remaining = sessions.length - shownCount - 1;
      if (DIRECTORY_PREFIX.length + candidate.length + omissionNotice(remaining).length + DIRECTORY_COVERAGE.length > MAX_DIRECTORY_CHARS) {
        return `${DIRECTORY_PREFIX}${directory}${omissionNotice(sessions.length - shownCount)}${DIRECTORY_COVERAGE}`;
      }
      directory = candidate;
      shownCount++;
    }
  }
  return `${DIRECTORY_PREFIX}${directory}${DIRECTORY_COVERAGE}`;
}
