import { describe, expect, it } from "vitest";
import { formatAutomationToolResult, MAX_AUTOMATION_TOOL_RESULT_CHARS } from "../src/automations/tool-results.js";

const schedule = (id = "target") => ({ id, title: "日报", kind: "background", status: "active", nextAt: 123,
  background: { prompt: "原正文", sources: [{ nodeId: "machine", automationId: "source" }] },
  latestPromptUpdate: { source: "current_turn", requestId: "message", revision: 7, updatedAt: 100 } });
function formatted(value: unknown) {
  const content = formatAutomationToolResult(value);
  expect(content.length).toBeLessThanOrEqual(MAX_AUTOMATION_TOOL_RESULT_CHARS);
  return JSON.parse(content);
}

describe("automation model tool result budget", () => {
  it("preserves the exact JSON shape for small objects, lists, null and errors", () => {
    for (const value of [schedule(), [schedule()], [], null, { error: "查询失败" }]) {
      expect(formatAutomationToolResult(value)).toBe(JSON.stringify(value));
    }
  });

  it("trims a long background body without losing its identity, metadata or edit revision", () => {
    const value = schedule();
    value.background.prompt = "正文".repeat(10_000);
    const result = formatted(value);
    expect(result).toMatchObject({ ...value, background: { ...value.background, prompt: expect.any(String) }, bodyTruncated: true });
    expect(result.background.prompt.length).toBeLessThan(value.background.prompt.length);
    expect(value.background.prompt).toHaveLength(20_000);
  });

  it("keeps a later edited schedule after a preceding schedule with a large body", () => {
    const first = schedule("first"), target = schedule("edited-target");
    first.background.prompt = "前置正文".repeat(6_000);
    target.background.prompt = "已编辑正文".repeat(6_000);
    const result = formatted([first, target]);
    expect(result).toMatchObject({ truncated: true, omittedCount: 0, items: [
      { id: "first", bodyTruncated: true },
      { id: "edited-target", latestPromptUpdate: target.latestPromptUpdate, bodyTruncated: true },
    ] });
  });

  it("reports the exact number omitted when list metadata exceeds the budget", () => {
    const values = Array.from({ length: 200 }, (_, id) => schedule(String(id)));
    const result = formatted(values);
    expect(result.truncated).toBe(true);
    expect(result.omittedCount).toBeGreaterThan(0);
    expect(result.items.length + result.omittedCount).toBe(values.length);
    expect(result.items.map((item: { id: string }) => item.id)).toEqual(values.slice(0, result.items.length).map(item => item.id));
    for (const item of result.items) expect(item.latestPromptUpdate.revision).toBe(7);
  });

  it("accounts for JSON escaping when retaining every schedule's metadata", () => {
    const values = Array.from({ length: 12 }, (_, id) => ({ ...schedule(String(id)),
      background: { prompt: "\u0000".repeat(4_000), preferences: ["😀".repeat(4_000)] } }));
    const result = formatted(values);
    expect(result.omittedCount).toBe(0);
    expect(result.items).toHaveLength(values.length);
    for (const item of result.items) {
      expect(item.latestPromptUpdate.revision).toBe(7);
      for (const body of [item.background.prompt, ...item.background.preferences]) expect(body).not.toMatch(/[\uD800-\uDBFF]$/);
    }
  });

  it("does not split a surrogate pair at the body preview boundary", () => {
    const result = formatted({ ...schedule(), background: { prompt: "a".repeat(255) + "😀" + "x".repeat(20_000) } });
    expect(result.background.prompt).toBe("a".repeat(255));
    expect(result.latestPromptUpdate.revision).toBe(7);
  });

  it("explicitly omits oversized metadata and still includes a later small schedule", () => {
    const huge = { ...schedule("oversized"), target: { nodeId: "n".repeat(20_000) } };
    expect(formatted([huge, schedule()])).toMatchObject({ truncated: true, omittedCount: 1, items: [{ id: "target" }] });
    expect(formatted(huge)).toEqual({ truncated: true, omittedCount: 1 });
  });

  it("preserves reminder, session and run metadata while marking abbreviated bodies", () => {
    const text = "x".repeat(20_000);
    for (const value of [
      { id: "reminder", kind: "reminder", status: "active", text },
      { id: "session", kind: "session", status: "active", prompt: text },
      { id: "run", scheduleId: "target", status: "failed", result: { text, error: text }, error: text },
    ]) {
      expect(formatted(value)).toMatchObject({ id: value.id, status: value.status, bodyTruncated: true });
    }
  });
});
