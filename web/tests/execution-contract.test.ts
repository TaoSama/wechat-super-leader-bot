import { describe, expect, it, vi } from "vitest";
import { fetchControlPlaneStatus, normalizeControlPlaneStatus } from "../src/api";
import { parseConsoleExecutions } from "../src/execution-contract";
import { emptyGoals, emptyExecutions, executionFixture  } from "./status-fixtures";

const snapshot = () => ({ ...emptyExecutions(), items: [executionFixture()] });
describe("required bounded console execution contract", () => {
  it("retains frozen targets, exact receipts and Unicode code point boundaries without mutation", () => {
    const value = snapshot();
    value.items[0].steps[0].prompt = "😀".repeat(512);
    value.items[0].steps[0].promptTruncated = true;
    const original = structuredClone(value);
    expect(parseConsoleExecutions(value)).toEqual(original);
    expect(normalizeControlPlaneStatus({ nodes: [], sessions: [], commands: [], goals: emptyGoals(), executions: value }).executions).toEqual(original);
    const parsed = parseConsoleExecutions(value);
    parsed.items[0].steps[1].dependsOn.push(3);
    expect(value).toEqual(original);
  });
  it("supports the entire 12-plan window and every projected step status", () => {
    const value = snapshot();
    value.items = Array.from({ length: 12 }, (_, index) => ({ ...executionFixture(), id: `plan-${index}` }));
    value.hasMore = true;
    expect(parseConsoleExecutions(value)).toEqual(value);
    for (const status of ["waiting", "claimed", "pending", "accepted", "completed", "failed", "uncertain", "cancelled", "expired"]) {
      const copy = snapshot();
      Object.assign(copy.items[0].steps[0], { status });
      expect(parseConsoleExecutions(copy).items[0].steps[0].status).toBe(status);
    }
    expect(parseConsoleExecutions(emptyExecutions()).items).toEqual([]);
  });
  const invalidCases: Array<[string, (value: ReturnType<typeof snapshot>) => unknown]> = [
    ["missing", () => undefined], ["null", () => null], ["array", () => []],
    ["invalid limit", value => ({ ...value, limit: 13 })],
    ["missing timestamp", value => ({ ...value, observedAt: undefined })],
    ["fractional timestamp", value => ({ ...value, observedAt: 0.5 })],
    ["unsafe timestamp", value => ({ ...value, observedAt: Number.MAX_SAFE_INTEGER + 1 })],
    ["invalid date range", value => ({ ...value, observedAt: 8_640_000_000_000_001 })],
    ["negative timestamp", value => ({ ...value, observedAt: -1 })],
    ["nonboolean hasMore", value => ({ ...value, hasMore: "false" })],
    ["nonarray items", value => ({ ...value, items: {} })],
    ["oversized window", value => ({ ...value, items: Array(13).fill(executionFixture()) })],
    ["duplicate plan", value => ({ ...value, items: [value.items[0], value.items[0]] })],
    ["private root", value => ({ ...value, token: "private" })],
    ["null plan", value => ({ ...value, items: [null] })],
    ["unknown plan status", value => { Object.assign(value.items[0], { status: "pending" }); return value; }],
    ["empty identity", value => { value.items[0].id = " "; return value; }],
    ["no authorization interval", value => { value.items[0].expiresAt = value.items[0].createdAt; return value; }],
    ["private chat", value => { Object.assign(value.items[0], { chatId: "private" }); return value; }],
    ["no steps", value => { value.items[0].steps = []; return value; }],
    ["too many steps", value => { value.items[0].steps = Array(5).fill(value.items[0].steps[0]); return value; }],
    ["invalid position", value => { value.items[0].steps[0].step = 2; return value; }],
    ["unknown step status", value => { Object.assign(value.items[0].steps[0], { status: "busy" }); return value; }],
    ["empty target", value => { value.items[0].steps[0].nodeId = ""; return value; }],
    ["nonstring prompt", value => { Object.assign(value.items[0].steps[0], { prompt: null }); return value; }],
    ["oversized prompt", value => { value.items[0].steps[0].prompt = "😀".repeat(513); return value; }],
    ["missing truncation flag", value => { Object.assign(value.items[0].steps[0], { promptTruncated: undefined }); return value; }],
    ["nonboolean truncation", value => { Object.assign(value.items[0].steps[0], { promptTruncated: 0 }); return value; }],
    ["nonarray dependencies", value => { Object.assign(value.items[0].steps[0], { dependsOn: null }); return value; }],
    ["self dependency", value => { value.items[0].steps[1].dependsOn = [2]; return value; }],
    ["forward dependency", value => { value.items[0].steps[0].dependsOn = [2]; return value; }],
    ["duplicate dependency", value => { value.items[0].steps[1].dependsOn = [1, 1]; return value; }],
    ["fractional dependency", value => { value.items[0].steps[1].dependsOn = [0.5]; return value; }],
    ["string dependency", value => { Object.assign(value.items[0].steps[1], { dependsOn: ["1"] }); return value; }],
    ["accepted without exact turn", value => { delete value.items[0].steps[0].turnId; return value; }],
    ["completed without exact command", value => { Object.assign(value.items[0].steps[0], { status: "completed" }); delete value.items[0].steps[0].commandId; return value; }],
    ["empty command", value => { value.items[0].steps[0].commandId = ""; return value; }],
    ["nonstring turn", value => { Object.assign(value.items[0].steps[0], { turnId: 1 }); return value; }],
    ["private output", value => { Object.assign(value.items[0].steps[0], { output: "private" }); return value; }],
  ];
  it.each(invalidCases)("rejects %s instead of inventing an empty plan window", (_name, mutate) => {
    const bad = mutate(snapshot());
    expect(() => parseConsoleExecutions(bad)).toThrow("持久计划状态格式无效");
    expect(() => normalizeControlPlaneStatus({ nodes: [], sessions: [], commands: [], goals: emptyGoals(), executions: bad })).toThrow("持久计划状态格式无效");
  });
  it("rejects a missing HTTP contract, then parses the same valid projection used by SSE", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ nodes: [], sessions: [], commands: [] })));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(fetchControlPlaneStatus()).rejects.toThrow("持久计划状态格式无效");
      const executions = snapshot();
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ nodes: [], sessions: [], commands: [], goals: emptyGoals(), executions })));
      expect((await fetchControlPlaneStatus()).executions).toEqual(executions);
      expect(fetchMock).toHaveBeenCalledWith("/v1/status", expect.objectContaining({ method: "GET", credentials: "same-origin" }));
    } finally { vi.unstubAllGlobals(); }
  });
});
