import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { readHistoryTurnStatuses } from "../../src/leader/history-turns.js";

type Rpc = Parameters<typeof readHistoryTurnStatuses>[0];
const target = (turnId: string) => [{ turnId }];
const refused: Rpc = async () => { throw new Error("private unavailable metadata"); };

test("deep history metadata resumes its own cursor across reads while refreshing the latest page", async () => {
  const calls: Array<string | undefined> = [];
  const rpc: Rpc = async (method, params, timeoutMs) => {
    assert.equal(method, "thread/turns/list");
    assert.equal(params.itemsView, "notLoaded");
    assert.equal(params.limit, 50);
    assert(timeoutMs > 0 && timeoutMs <= 1_000);
    calls.push(params.cursor as string | undefined);
    const start = params.cursor ? Number(String(params.cursor).slice(5)) : 0;
    return { data: Array.from({ length: Math.min(50, 201 - start) }, (_, index) => ({ id: `turn-${start + index}`, status: "completed" })),
      nextCursor: start + 50 < 201 ? `page-${start + 50}` : null };
  };
  const key = randomUUID();
  assert.equal(await readHistoryTurnStatuses(rpc, key, "thread", target("turn-200")), undefined);
  assert.equal(calls.length, 3);
  assert.deepEqual(await readHistoryTurnStatuses(rpc, key, "thread", target("turn-200")), { "turn-200": "completed" });
  assert.deepEqual(calls, [undefined, "page-50", "page-100", undefined, "page-150", "page-200"]);
});

test("polling the latest item page also delivers statuses discovered for a previously loaded deep page", async () => {
  const rpc: Rpc = async (_method, params) => {
    const start = params.cursor ? Number(String(params.cursor).slice(5)) : 0;
    return { data: Array.from({ length: Math.min(50, 201 - start) }, (_, index) => ({ id: `turn-${start + index}`, status: "completed" })),
      nextCursor: start + 50 < 201 ? `page-${start + 50}` : null };
  };
  const key = randomUUID();
  assert.equal(await readHistoryTurnStatuses(rpc, key, "thread", target("turn-200")), undefined);
  const latest = await readHistoryTurnStatuses(rpc, key, "thread", target("turn-0"));
  assert.equal(latest?.["turn-0"], "completed");
  assert.equal(latest?.["turn-200"], "completed");
  const nextPoll = await readHistoryTurnStatuses(rpc, key, "thread", target("turn-0"));
  assert.equal(nextPoll?.["turn-200"], "completed");
});

test("an old in-progress turn that leaves the latest page is scanned again instead of freezing", async () => {
  let moved = false;
  const calls: Array<string | undefined> = [];
  const rpc: Rpc = async (_method, params) => {
    calls.push(params.cursor as string | undefined);
    return !moved ? { data: [{ id: "old", status: "inProgress" }], nextCursor: null }
      : params.cursor ? { data: [{ id: "old", status: "completed" }], nextCursor: null }
        : { data: [{ id: "new", status: "completed" }], nextCursor: "old-turns" };
  };
  const key = randomUUID();
  assert.deepEqual(await readHistoryTurnStatuses(rpc, key, "thread", target("old")), { old: "inProgress" });
  moved = true;
  assert.deepEqual(await readHistoryTurnStatuses(rpc, key, "thread", target("old")), { old: "completed" });
  assert.deepEqual(calls, [undefined, undefined, "old-turns"]);
});

test("a failed old metadata cursor restarts a bounded scan and eventually reaches deep turns", async () => {
  let rejectCursor = true;
  let calls = 0;
  const rpc: Rpc = async (_method, params) => {
    calls++;
    const start = params.cursor ? Number(String(params.cursor).slice(5)) : 0;
    if (start === 150 && rejectCursor) { rejectCursor = false; throw new Error("expired cursor"); }
    return { data: Array.from({ length: Math.min(50, 201 - start) }, (_, index) => ({ id: `turn-${start + index}`, status: "completed" })),
      nextCursor: start + 50 < 201 ? `page-${start + 50}` : null };
  };
  const key = randomUUID();
  const perRead: number[] = [];
  for (let read = 0; read < 3; read++) {
    const before = calls;
    assert.equal(await readHistoryTurnStatuses(rpc, key, "thread", target("turn-200")), undefined);
    perRead.push(calls - before);
  }
  const before = calls;
  assert.deepEqual(await readHistoryTurnStatuses(rpc, key, "thread", target("turn-200")), { "turn-200": "completed" });
  perRead.push(calls - before);
  assert.deepEqual(perRead, [3, 2, 3, 3]);
});

test("concurrent views use cached exact metadata without queuing another native read", async () => {
  const key = randomUUID();
  let release!: (value: unknown) => void;
  let calls = 0;
  const rpc: Rpc = async () => { calls++; return new Promise(resolve => { release = resolve; }); };
  const pending = readHistoryTurnStatuses(rpc, key, "thread", target("turn"));
  assert.equal(await readHistoryTurnStatuses(rpc, key, "thread", target("turn")), undefined);
  release({ data: [{ id: "turn", status: "failed" }], nextCursor: null });
  assert.deepEqual(await pending, { turn: "failed" });
  assert.equal(calls, 1);
});

test("the metadata deadline is shared across pages instead of restarting for each RPC", async () => {
  const budgets: number[] = [];
  const rpc: Rpc = async (_method, _params, timeoutMs) => {
    budgets.push(timeoutMs);
    await delay(Math.min(600, timeoutMs));
    if (timeoutMs < 600) throw new Error("metadata request timed out");
    return { data: [], nextCursor: `page-${budgets.length}` };
  };
  assert.equal(await readHistoryTurnStatuses(rpc, randomUUID(), "thread", target("unknown")), undefined);
  assert.equal(budgets.length, 2);
  assert(budgets[1] < 500);
});

test("metadata caches expire and evict old runtime targets within their fixed capacity", async context => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const rpc: Rpc = async () => ({ data: [{ id: "turn", status: "completed" }], nextCursor: null });
  const prefix = randomUUID();
  for (let index = 0; index < 17; index++) {
    context.mock.timers.tick(1);
    assert.deepEqual(await readHistoryTurnStatuses(rpc, `${prefix}-${index}`, "thread", target("turn")), { turn: "completed" });
  }
  assert.equal(await readHistoryTurnStatuses(refused, `${prefix}-0`, "thread", target("turn")), undefined);
  const key = randomUUID();
  assert.deepEqual(await readHistoryTurnStatuses(rpc, key, "thread", target("turn")), { turn: "completed" });
  context.mock.timers.tick(10 * 60 * 1000 + 1);
  assert.equal(await readHistoryTurnStatuses(refused, key, "thread", target("turn")), undefined);
});

test("cached requested turns and metadata returned for all loaded pages stay bounded", async () => {
  const key = randomUUID();
  for (let page = 0; page < 42; page++) {
    const items = Array.from({ length: 50 }, (_, index) => ({ turnId: `turn-${page * 50 + index}` }));
    const rpc: Rpc = async () => ({ data: items.map(item => ({ id: item.turnId, status: "completed" })), nextCursor: null });
    const statuses = await readHistoryTurnStatuses(rpc, key, "thread", items);
    assert.equal(Object.keys(statuses!).length, Math.min((page + 1) * 50, 2048));
  }
  assert.equal((await readHistoryTurnStatuses(refused, key, "thread", target("turn-0")))?.["turn-0"], undefined);
  assert.equal((await readHistoryTurnStatuses(refused, key, "thread", target("turn-2099")))?.["turn-2099"], "completed");
});
