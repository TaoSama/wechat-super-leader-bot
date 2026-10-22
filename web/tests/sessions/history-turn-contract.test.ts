import { afterEach, expect, it, vi } from "vitest";
import { fetchSessionHistory } from "../../src/api/sessions";
const PAGE = { session: { id: "session", observedAt: "2026-10-11T10:00:00Z" }, historyContext: "cf7e282f-d6d2-4a98-a517-9fb753f2549b", source: "codex-desktop", fetchedAt: "2026-10-11T10:00:00Z", nextCursor: null, items: [{ id: "one", turnId: "turn", kind: "tool", type: "commandExecution", text: "output" }] };
const serve = (change: Record<string, unknown>) => vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...PAGE, ...change }))));
afterEach(() => vi.unstubAllGlobals());
it.each(["completed", "inProgress", "failed", "interrupted"])("准确解析可选turn状态%s", async turnStatus => {
  serve({ items: [{ ...PAGE.items[0], turnStatus }], turnStatuses: { turn: turnStatus } });
  expect(await fetchSessionHistory("node", "session")).toMatchObject({ items: [{ turnStatus }], turnStatuses: { turn: turnStatus } });
});
it("旧daemon无turn字段仍可读取", async () => {
  serve({});
  expect((await fetchSessionHistory("node", "session")).items[0].turnStatus).toBeUndefined();
});
it.each(["active", "", {}, null, ["completed"]])("拒绝畸形item turnStatus %#", async turnStatus => {
  serve({ items: [{ ...PAGE.items[0], turnStatus }] });
  await expect(fetchSessionHistory("node", "session")).rejects.toThrow("轮次状态无效");
});
it.each([[], null, { turn: "unknown" }, { "": "completed" }, { ["界".repeat(43)]: "completed" }, Object.fromEntries(Array.from({ length: 2049 }, (_, index) => [String(index), "completed"]))])("拒绝畸形或无界metadata %#", async turnStatuses => {
  serve({ turnStatuses });
  await expect(fetchSessionHistory("node", "session")).rejects.toThrow("轮次状态无效");
});
