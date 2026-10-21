import { describe, expect, it } from "vitest";
import { markdownToWeChat } from "@super-leader/wechat-text";
import { groupSessionProjects, MAX_DIRECTORY_CHARS, renderSessionDirectory, sessionStatusLabel, type DirectorySession } from "../../../src/leader/queries/session-directory.js";
import { SessionTitles } from "../../../src/leader/queries/session-titles.js";

const session = (id: string, overrides: Partial<DirectorySession> = {}): DirectorySession => ({
  id, title: `原始标题 ${id}`, nodeId: "demoair", nodeName: "demoair", cwd: "/work/app",
  updatedAt: "2026-10-21T01:00:00Z", executionStatus: "idle", modelView: { model: "gpt-6.1-sol" }, ...overrides,
});
const visible = (text: string) => markdownToWeChat(text, Number.MAX_SAFE_INTEGER);

describe("WeChat project directory", () => {
  it("sorts projects by their newest session, and each project by update time", () => {
    const titles = new SessionTitles();
    const result = titles.listing({ sessions: [
      session("old", { updatedAt: "2026-10-20T01:00:00Z" }),
      session("other", { cwd: "/work/other", updatedAt: "2026-10-21T02:00:00Z" }),
      session("new", { updatedAt: "2026-10-21T03:00:00Z", executionStatus: "active" }),
      session("unknown", { updatedAt: undefined }),
    ] });
    expect(result.sessions.map(item => item.id)).toEqual(["new", "old", "unknown", "other"]);
    expect(result.sessions[0]).toMatchObject({ project: { name: "app", path: "/work/app", machineName: "demoair", groupLabel: "app（demoair）" } });
    const body = visible(titles.render("按机器列出：\n[demoair] 改写的标题"));
    expect(body.indexOf("app（demoair）")).toBeLessThan(body.indexOf("other（demoair）"));
    expect(body.indexOf("原始标题 new")).toBeLessThan(body.indexOf("原始标题 old"));
    expect(body).toContain("1. [忙] 原始标题 new\n2. [闲] 原始标题 old\n3. [闲] 原始标题 unknown");
    expect(body).toContain("other（demoair）\n4. [闲] 原始标题 other");
    expect(body).not.toContain("模型：");
    expect(body).not.toContain("gpt-6.1-sol");
    expect(body).not.toContain("[demoair]");
    expect(body).not.toContain("改写的标题");
  });

  it("keeps same-named projects on different machines and different paths separate", () => {
    const groups = groupSessionProjects([
      session("air"), session("mini", { nodeId: "mini", nodeName: "demomini" }),
      session("other-path", { cwd: "/other/app" }),
    ]);
    expect(groups).toHaveLength(3);
    expect(groups.map(group => group.project.groupLabel).sort()).toEqual([
      "app（demoair · /other/app）", "app（demoair · /work/app）", "app（demomini）",
    ].sort());
  });

  it("uses actual execution state, keeps unknown unknown, and never substitutes observation time for update time", () => {
    const groups = groupSessionProjects([session("unknown", { updatedAt: "invalid", executionStatus: "notLoaded" }), session("known")]);
    expect(groups[0].sessions.map(item => item.id)).toEqual(["known", "unknown"]);
    const body = visible(renderSessionDirectory(groups[0].sessions));
    expect(body).toContain("2. [未载] 原始标题 unknown");
    expect(visible(renderSessionDirectory([session("s", { executionStatus: "unexpected" })]))).toContain("[未知]");
  });

  it.each([
    ["active", "忙"], ["busy", "忙"], ["running", "忙"], ["idle", "闲"], ["done", "完"],
    ["blocked", "等"], ["notLoaded", "未载"], ["unknown", "未知"], ["error", "错"],
    ["unexpected", "未知"], [undefined, "未知"],
  ])("uses a compact, accurate label for execution state %s", (status, label) => {
    expect(sessionStatusLabel(status)).toBe(label);
  });

  it("keeps identical titles distinct by their global list number without appending session IDs", () => {
    const title = "共同标题 | GPT-6.1-Sol";
    const body = visible(renderSessionDirectory([
      session("abcdefgh-one", { title }),
      session("abcdefgh-two", { title }),
      session("abcdefgh-three", { title, cwd: "/work/other" }),
    ]));
    expect(body).toContain(`1. [闲] ${title}\n2. [闲] ${title}`);
    expect(body).toContain(`other（demoair）\n3. [闲] ${title}`);
    expect(body).not.toContain("abcdefgh");
    expect(body).not.toContain("模型：");
  });

  it("preserves literal titles and project names through the WeChat renderer", () => {
    const title = " **完整原题** `代码` #tag\n[链接](https://example.com) ①② ";
    const body = visible(renderSessionDirectory([session("s", { title, cwd: "/work/**project**" })]));
    expect(body).toContain(title);
    expect(body).toContain("**project**（demoair）");
  });

  it("keeps projectless sessions explicit and normalizes Windows and trailing separators", () => {
    const groups = groupSessionProjects([
      session("missing", { cwd: "", nodeName: undefined }),
      session("windows", { cwd: "C:\\work\\project\\" }),
      session("same", { cwd: "C:/work/project" }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.find(group => group.project.name === "project")?.sessions).toHaveLength(2);
    expect(groups.find(group => group.project.name === "未关联 Project")?.project.machineName).toBe("demoair");
  });

  it("renders more than a model reply limit without dropping or truncating a session", () => {
    const titles = new SessionTitles();
    titles.listing({ sessions: Array.from({ length: 80 }, (_, index) => session(String(index), { title: `原始会话 ${index} ${"长标题".repeat(40)}` })) });
    const body = visible(titles.render("会话很多，请搜索"));
    expect(body.length).toBeGreaterThan(6000);
    expect(body.match(/\[闲\] 原始会话 /gu)).toHaveLength(80);
    expect(body).toContain("80. [闲] 原始会话 79");
    expect(body).not.toContain("请搜索");
  });

  it("replaces a prior listing scope, including an empty filtered result", () => {
    const titles = new SessionTitles();
    titles.listing({ sessions: [session("old")] });
    titles.listing({ sessions: [session("new")] });
    expect(titles.render("列表")).not.toContain("原始标题 old");
    titles.listing({ sessions: [] });
    expect(titles.rendersDirectory()).toBe(true);
    expect(titles.render("所有机器都没有任务")).toBe("当前筛选范围的已观测快照未发现会话；仅覆盖在线节点已观测的会话。");
    titles.independent();
    expect(titles.rendersDirectory()).toBe(false);
    expect(titles.render("没有计划")).toBe("没有计划");
  });

  it("bounds 150+ sessions including the exact omission count and coverage suffix, preserving every shown title", () => {
    const sessions = Array.from({ length: 170 }, (_, index) => session(String(index), {
      title: `完整标题-${index}-${"😀**字**".repeat(30)}-结束`,
      cwd: `/work/project-${Math.floor(index / 30)}`,
    }));
    const raw = renderSessionDirectory(sessions);
    const body = visible(raw);
    const shown = sessions.filter(item => body.includes(item.title!));
    expect(raw.length).toBeLessThanOrEqual(MAX_DIRECTORY_CHARS);
    expect(body.length).toBeLessThanOrEqual(MAX_DIRECTORY_CHARS);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(sessions.length);
    expect(body).toContain(`另有${sessions.length - shown.length}个会话因消息长度限制未展示。`);
    expect(body).toMatch(/仅展示在线节点已观测的会话。$/u);
    expect(body.match(/\[闲\]/gu)).toHaveLength(shown.length);
    expect([...body.matchAll(/^(\d+)\. \[闲\]/gmu)].map(match => Number(match[1])))
      .toEqual(Array.from({ length: shown.length }, (_, index) => index + 1));
    for (const item of sessions) {
      if (body.includes(`完整标题-${item.id}-`)) expect(body).toContain(item.title);
    }
  });

  it("omits an oversized complete title instead of cutting it or later project headers", () => {
    const raw = renderSessionDirectory([
      session("small", { title: "先展示的完整原题", updatedAt: "2026-10-21T04:00:00Z" }),
      session("huge", { title: `超长标题-${"😀".repeat(MAX_DIRECTORY_CHARS)}-必须完整`, cwd: "/work/next" }),
      session("last", { title: "最后一个完整原题", cwd: "/work/last", updatedAt: "2026-10-20T04:00:00Z" }),
    ]);
    const body = visible(raw);
    expect(raw.length).toBeLessThanOrEqual(MAX_DIRECTORY_CHARS);
    expect(body).toContain("先展示的完整原题");
    expect(body).toContain("另有2个会话因消息长度限制未展示。");
    expect(body).not.toContain("超长标题-");
    expect(body).not.toContain("next（");
    expect(body).not.toContain("last（");
  });

  it("explains when even the first full session cannot fit", () => {
    const raw = renderSessionDirectory([session("huge", { title: "完整超长原题".repeat(MAX_DIRECTORY_CHARS) })]);
    expect(raw.length).toBeLessThanOrEqual(MAX_DIRECTORY_CHARS);
    expect(raw).toContain("另有1个会话因消息长度限制未展示。");
    expect(raw).not.toContain("完整超长原题");
    expect(raw).not.toContain("app（demoair）");
  });

  it("returns all sessions when the complete directory fits exactly within the budget", () => {
    const baseline = [session("long", { title: "完整标题" }), session("short", { title: "末项", modelView: undefined })];
    const padding = MAX_DIRECTORY_CHARS - renderSessionDirectory(baseline).length;
    baseline[0].title += "字".repeat(padding);
    const raw = renderSessionDirectory(baseline);
    expect(raw.length).toBe(MAX_DIRECTORY_CHARS);
    expect(raw).toContain("末项");
    expect(raw).not.toContain("未展示");
  });
});
