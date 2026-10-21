import { describe, expect, it } from "vitest";
import { SessionTitles } from "../../../src/leader/queries/session-titles.js";
import { sessionLabel } from "../../../src/leader/plans/presentation.js";
import { markdownToWeChat } from "@super-leader/wechat-text";

const ORIGINAL = " 🟢 [微信] 异步 typing · 合并上线 | GPT-6.1-Sol  ";
const session = (id = "session-a", title = ORIGINAL, nodeId = "mac") => ({ id, title, nodeId,
  executionStatus: "active", modelView: { model: "gpt-6.1-sol" } });
const visible = (text: string) => markdownToWeChat(text, Number.MAX_SAFE_INTEGER);

describe("session title identity rendering", () => {
  it("expands server-bound references without changing any original title characters", () => {
    const titles = new SessionTitles();
    const { sessions } = titles.listing({ sessions: [session()] });
    expect(sessions[0].title).toBe(ORIGINAL);
    expect(visible(titles.render(`${sessions[0].displayLabel}\n正在核对资料`))).toBe(`已观测会话：\n\n未关联 Project（mac）\n[运行中] ${ORIGINAL}\n模型：gpt-6.1-sol\n\n仅展示在线节点已观测的会话。`);
    expect(visible(sessionLabel("mac", "session-a", ORIGINAL))).toBe(`[mac] ${ORIGINAL}`);
  });

  it("replaces a rewritten listing entirely with canonical titles and observed facts", () => {
    const titles = new SessionTitles();
    titles.listing({ sessions: [session()] });
    const rendered = visible(titles.render("微信 typing：已经完成上线。\n另起的新名字：待检查"));
    expect(rendered).toBe(`已观测会话：\n\n未关联 Project（mac）\n[运行中] ${ORIGINAL}\n模型：gpt-6.1-sol\n\n仅展示在线节点已观测的会话。`);
    expect(rendered).not.toContain("另起的新名字");
    expect(rendered).not.toContain("已经完成上线");
  });

  it("preserves a clarification about one explicitly referenced candidate after discovering several sessions", () => {
    const titles = new SessionTitles();
    const listed = titles.listing({ sessions: [session(), session("session-b", "另一个原题")] });
    expect(titles.candidates([{ nodeId: "mac", sessionId: "session-a" }])).toHaveProperty("candidates");
    const body = `未找到原题为「旧版标题 · 可靠通知交付 · 合并上线」的会话。\n\n你指的是当前这个会话吗？\n${listed.sessions[0].displayLabel}\n\n尚未派发任务，等你确认目标。`;
    const rendered = visible(titles.render(body));
    expect(rendered).toBe(`未找到原题为「旧版标题 · 可靠通知交付 · 合并上线」的会话。\n\n你指的是当前这个会话吗？\n[mac] ${ORIGINAL}\n\n尚未派发任务，等你确认目标。`);
    expect(rendered).not.toContain("另一个原题");
    expect(rendered).not.toContain("已观测会话");
  });

  it("rejects a partial faithful directory mixed with a renamed remaining session", () => {
    const titles = new SessionTitles();
    const listed = titles.listing({ sessions: [session(), session("session-b", "第二个完整原题")] });
    const rendered = visible(titles.render(`${listed.sessions[0].displayLabel}\n运行中\n改写后的B：空闲`));
    expect(rendered).toContain(ORIGINAL);
    expect(rendered).toContain("第二个完整原题");
    expect(rendered).not.toContain("改写后的B");
  });

  it("accepts only distinct candidates from the current discovered listing", () => {
    const titles = new SessionTitles();
    titles.add(session());
    const target = { nodeId: "mac", sessionId: "session-a" };
    expect(titles.candidates([target])).toHaveProperty("error");
    titles.listing({ sessions: [session()] });
    expect(titles.candidates([{ ...target, sessionId: "unknown" }])).toHaveProperty("error");
    expect(titles.candidates([target, target])).toHaveProperty("error");
    expect(titles.candidates([])).toHaveProperty("error");
    expect(titles.candidates([target])).toMatchObject({ candidates: [{ ...target, displayLabel: expect.stringMatching(/^⟦session:/) }] });
  });

  it.each(["candidate", "specific-progress"])("restores the full directory scope after %s then a new listing", mode => {
    const titles = new SessionTitles();
    const sessions = [session(), session("session-b", "第二个完整原题")];
    titles.listing({ sessions });
    if (mode === "candidate") titles.candidates([{ nodeId: "mac", sessionId: "session-a" }]);
    else titles.add(session(), true);
    const refreshed = titles.listing({ sessions });
    const rendered = visible(titles.render(`${refreshed.sessions[0].displayLabel}\n运行中\n改写后的B：空闲`));
    expect(rendered).toContain(ORIGINAL);
    expect(rendered).toContain("第二个完整原题");
    expect(rendered).not.toContain("改写后的B");
  });

  it("retains exact repeated titles and distinguishes same-node IDs and separate nodes", () => {
    const titles = new SessionTitles();
    const listed = titles.listing({ sessions: [session("12345678a"), session("12345678b"), session("12345678a", ORIGINAL, "mini")] });
    const rendered = visible(titles.render(listed.sessions.map(item => item.displayLabel).join("\n")));
    expect(rendered).toContain(`未关联 Project（mac）\n[运行中] ${ORIGINAL}（12345678a）\n模型：gpt-6.1-sol\n\n[运行中] ${ORIGINAL}（12345678b）`);
    expect(rendered).toContain(`未关联 Project（mini）\n[运行中] ${ORIGINAL}`);
  });

  it("binds the correct specific target before preserving model progress analysis", () => {
    const titles = new SessionTitles();
    titles.listing({ sessions: [session(), session("session-b", "第二个原题")] });
    titles.add(session(), true);
    expect(visible(titles.render("已读到本轮在核查配置，尚未确认完成。"))).toBe(`[mac] ${ORIGINAL}\n\n已读到本轮在核查配置，尚未确认完成。`);
  });

  it("never accepts an invented or previous-turn reference as a displayed title", () => {
    const titles = new SessionTitles();
    const ref = titles.add(session());
    const rendered = visible(titles.render(`${ref}\n⟦session:invented:1⟧：已完成`));
    expect(rendered).toBe(`已观测会话：\n\n[mac] ${ORIGINAL}\n运行中；模型：gpt-6.1-sol`);
  });

  it("retains markdown characters and multiline title text literally in the rendered response", () => {
    const title = "**literal** `code` #heading\n[链接](https://example.com) ①②";
    const titles = new SessionTitles();
    const ref = titles.add(session("s", title));
    expect(visible(titles.render(ref))).toContain(title);
  });

  it.each(["`literal`", "``literal``", "# 标题\n①② **literal**", "[literal](https://example.com)", " **literal**  "])("protects the literal title %j through the actual WeChat renderer", title => {
    const titles = new SessionTitles();
    const ref = titles.add(session("s", title));
    expect(visible(titles.render(`${ref}\n结束`))).toContain(title);
  });

  it("keeps ordinary replies and title-free sessions usable", () => {
    const titles = new SessionTitles();
    expect(titles.render("普通问答")).toBe("普通问答");
    const ref = titles.add(session("abcdefghi", " \n "));
    expect(titles.render(ref)).toBe("[mac] 会话 abcdefgh");
  });

  it("preserves an independent no-plan answer without disabling future title queries", () => {
    const titles = new SessionTitles();
    titles.listing({ sessions: [session()] });
    titles.independent();
    expect(titles.render("当前没有已授权计划。")).toBe("当前没有已授权计划。");
    titles.listing({ sessions: [session()] });
    expect(visible(titles.render("改写标题：运行中"))).toContain(ORIGINAL);
    expect(titles.render("改写标题：运行中")).not.toContain("改写标题");
  });

  it("binds progress to previously discovered original titles when a target is no longer live", () => {
    const titles = new SessionTitles();
    titles.listing({ sessions: [session()] });
    const focused = titles.focus([{ nodeId: "mac", sessionId: "session-a" }], () => undefined);
    expect(focused[0].displayLabel).toMatch(/^⟦session:/);
    expect(visible(titles.render("该指令已接收，完成情况待核查。"))).toBe(`[mac] ${ORIGINAL}\n\n该指令已接收，完成情况待核查。`);
  });
});
