import { expect, it, vi } from "vitest";
import { parseConsoleGoals } from "../../src/features/leader/goal-contract";
import { fetchControlPlaneStatus } from "../../src/api/status";
import { normalizeControlPlaneStatus } from "../../src/api/normalizers";
import { emptyExecutions, emptyGoals, goalFixture } from "../fixtures/status-fixtures";
const snapshot = () => ({ ...emptyGoals(), items: [goalFixture()] });
it("requires goals on HTTP and SSE and clones the same exact bounded public contract", async () => {
  const goals = snapshot(); goals.items[0].objective = "🙂".repeat(512);
  const source = structuredClone(goals), parsed = parseConsoleGoals(goals);
  expect(parsed).toEqual(source); parsed.items[0].actions[1].sourceActions.push(2); expect(goals).toEqual(source);
  const body = { nodes: [], sessions: [], commands: [], executions: emptyExecutions(), goals };
  expect(normalizeControlPlaneStatus(body).goals).toEqual(goals);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body))));
  try { expect((await fetchControlPlaneStatus()).goals).toEqual(goals); }
  finally { vi.unstubAllGlobals(); }
  expect(() => normalizeControlPlaneStatus({ ...body, goals: undefined })).toThrow("持续目标状态格式无效");
});
it.each([
  "waiting", "claimed", "pending", "accepted", "completed", "failed", "uncertain", "blocked", "cancelled", "expired",
])("recognizes projected action state %s without inventing successful completion", status => {
  const value = snapshot(); Object.assign(value.items[0].actions[1], { status });
  expect(parseConsoleGoals(value).items[0].criteria[0].supported).toBe(false);
});
const mutations: ((value: ReturnType<typeof snapshot>) => unknown)[] = [
  () => undefined, () => null, () => [], value => ({ ...value, limit: 13 }), value => ({ ...value, observedAt: -1 }),
  value => ({ ...value, items: Array(13).fill(value.items[0]) }), value => ({ ...value, items: [value.items[0], value.items[0]] }),
  value => { Object.assign(value.items[0], { chatId: "private" }); return value; },
  value => { value.items[0].id = "invalid"; return value; },
  value => { value.items[0].targets.push(value.items[0].targets[0]); return value; },
  value => { value.items[0].targets[0].sessionId = "terminal:abc"; return value; },
  value => { value.items[0].actions[1].sourceActions = [2]; return value; },
  value => { value.items[0].actions[1].target = 3; return value; },
  value => { value.items[0].actions[1].turnId = "wrong turn"; return value; },
  value => { delete value.items[0].actions[1].commandId; return value; },
  value => { value.items[0].criteria[0].supported = true; value.items[0].criteria[0].actions = [2]; return value; },
  value => { value.items[0].status = "completed"; value.items[0].criteria[0].supported = true; return value; },
  value => { value.items[0].decisionAttempts = 6; return value; },
  value => { value.items[0].objective = "🙂".repeat(513); return value; },
];
it.each(mutations)("rejects malformed, private, expanded or contradictory data %#", mutate => {
  expect(() => parseConsoleGoals(mutate(snapshot()))).toThrow("持续目标状态格式无效");
});
