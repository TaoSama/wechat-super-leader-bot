import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const FIXTURE_PREFIX = 'plan-store-fixture-';
const CONFIRMATION_MS = 10 * 60 * 1000;
const PARALLEL_CLAIMS = 8;
const PAGE_LIMIT = 2;
const PAGE_FIXTURES = 9;
const MAX_PAGES = 100;

// Run before Controller startup, after the caller initializes the database once.
// Never init supplied or reopened stores: that would reset unrelated commands.
export async function verifyPlanStore({ stores, reopenStore }) {
  assert.equal(stores.length, 2, 'Two independent PostgreSQL clients are required');
  assert.equal(typeof reopenStore, 'function', 'A new-store factory is required for reconnect verification');
  const { createExecution, EXECUTION_CLAIM_MS } = await import('../../../controller/dist/leader/plans/execution.js');
  const fixtureTag = randomUUID();
  const tracked = new Map();
  let reopened, failure;
  const make = (suffix, now = Date.now()) => {
    const id = randomUUID();
    const execution = createExecution(`${FIXTURE_PREFIX}${fixtureTag.slice(0, 8)}-${suffix}`, {
      id, expiresAt: now + CONFIRMATION_MS,
      actions: [
        { nodeId: 'plan-store-fixture-node', sessionId: 'first', prompt: 'fixture-only-first',
          sendRoute: 'desktop-owner', dependsOn: [] },
        { nodeId: 'plan-store-fixture-node', sessionId: 'second', prompt: 'fixture-only-second',
          sendRoute: 'control-socket', dependsOn: [1] },
      ],
    }, now);
    tracked.set(id, execution);
    return execution;
  };
  const next = (execution, patch = {}) => ({ ...structuredClone(execution), revision: execution.revision + 1, ...patch });
  try {
    const original = make('same-plan');
    const same = await Promise.all(stores.map(store => store.createExecutionIfAbsent(original)));
    assert.equal(same.filter(result => result.created).length, 1, 'Same-plan concurrent create must have one winner');
    for (const result of same) assert.deepEqual(result.execution, original);
    const retry = { ...structuredClone(original), createdAt: original.createdAt + 1, expiresAt: original.expiresAt + 1 };
    assert.deepEqual((await stores[1].createExecutionIfAbsent(retry)).execution, original, 'Retry reset authorization timestamps');
    const different = make('other-plan');
    different.chatId = original.chatId;
    await assert.rejects(stores[1].createExecutionIfAbsent(different), { name: 'ConflictError' });
    await assert.rejects(stores[1].createExecutionIfAbsent({ ...original, chatId: `${original.chatId}-other` }), { name: 'ConflictError' });
    const editedPlan = structuredClone(original);
    editedPlan.plan.actions[0].prompt = 'edited confirmed plan';
    await assert.rejects(stores[1].createExecutionIfAbsent(editedPlan), { name: 'ConflictError' });

    const contenders = [make('chat-race'), make('chat-race')];
    const raced = await Promise.allSettled(stores.map((store, index) => store.createExecutionIfAbsent(contenders[index])));
    assert.equal(raced.filter(result => result.status === 'fulfilled').length, 1, 'Distinct plans in one chat must have one active winner');
    for (const result of raced) if (result.status === 'rejected') assert.equal(result.reason.name, 'ConflictError');
    const activeRace = await stores[0].getLatestExecution(contenders[0].chatId);
    assert.equal(activeRace.status, 'active');
    assert(contenders.some(execution => execution.id === activeRace.id));
    const isolated = make('isolated');
    await stores[1].createExecutionIfAbsent(isolated);
    assert.deepEqual(await stores[0].getLatestExecution(isolated.chatId), isolated, 'Other chat mutated execution ownership');

    const claims = Array.from({ length: PARALLEL_CLAIMS }, (_, index) => {
      const claimed = next(original);
      claimed.attempts[0] = { token: randomUUID(), startedAt: original.createdAt,
        expiresAt: original.createdAt + EXECUTION_CLAIM_MS };
      return stores[index % stores.length].compareAndSetExecution(claimed, original.revision);
    });
    const winners = (await Promise.all(claims)).filter(Boolean);
    assert.equal(winners.length, 1, 'Concurrent CAS claim must have one winner');
    const claimed = structuredClone(winners[0]);
    winners[0].attempts[0].token = randomUUID();
    assert.deepEqual(await stores[1].getExecution(original.id), claimed);
    const cleared = next(claimed);
    cleared.attempts[0] = null;
    await assert.rejects(stores[1].compareAndSetExecution(cleared, claimed.revision), /attempt/);
    const replaced = next(claimed);
    replaced.attempts[0].token = randomUUID();
    await assert.rejects(stores[1].compareAndSetExecution(replaced, claimed.revision), /attempt/);
    await assert.rejects(stores[1].compareAndSetExecution(next(claimed, { expiresAt: claimed.expiresAt - 1 }), claimed.revision), /immutable/);
    await assert.rejects(stores[1].compareAndSetExecution(next(claimed, {
      createdAt: claimed.createdAt - 1, expiresAt: claimed.expiresAt - 1,
    }), claimed.revision), /immutable/);
    assert.deepEqual(await stores[0].getExecution(original.id), claimed, 'Rejected mutation changed durable state');
    assert.equal(await stores[0].compareAndSetExecution(next(original), original.revision), null, 'Stale revision advanced');

    const terminal = next(claimed, { status: 'cancelled' });
    assert.deepEqual(await stores[0].compareAndSetExecution(terminal, claimed.revision), terminal);
    assert.equal(await stores[1].compareAndSetExecution(next(terminal, { status: 'active' }), terminal.revision), null);
    assert.deepEqual((await stores[1].createExecutionIfAbsent(original)).execution, terminal, 'Idempotent create resurrected terminal execution');
    const successor = make('same-plan');
    assert.equal((await stores[1].createExecutionIfAbsent(successor)).created, true, 'Terminal execution blocked a new plan');
    assert.deepEqual(await stores[0].getLatestExecution(successor.chatId), successor);

    const cloneInput = make('clone');
    const cloneExpected = structuredClone(cloneInput);
    const cloneCreated = await stores[0].createExecutionIfAbsent(cloneInput);
    cloneInput.plan.actions[0].prompt = 'changed caller input';
    cloneCreated.execution.plan.actions[0].dependsOn.push(4);
    const cloneRead = await stores[1].getExecution(cloneExpected.id);
    cloneRead.plan.actions[0].prompt = 'changed read output';
    const cloneLatest = await stores[1].getLatestExecution(cloneExpected.chatId);
    cloneLatest.plan.actions[1].dependsOn.length = 0;
    assert.deepEqual(await stores[0].getExecution(cloneExpected.id), cloneExpected, 'Caller mutation leaked into PostgreSQL state');

    const pageFixtures = Array.from({ length: PAGE_FIXTURES }, (_, index) => make(`page-${index}`));
    await Promise.all(pageFixtures.map((execution, index) => stores[index % stores.length].createExecutionIfAbsent(execution)));
    const expectedIds = (await Promise.all([...tracked.keys()].map(id => stores[0].getExecution(id))))
      .filter(execution => execution?.status === 'active').map(execution => execution.id).sort();
    const seen = new Set();
    let cursor = '', pages = 0;
    while (true) {
      const page = await stores[1].listActiveExecutions(PAGE_LIMIT, cursor);
      assert(page.length <= PAGE_LIMIT);
      if (!page.length) break;
      for (const execution of page) {
        assert.equal(execution.status, 'active');
        assert(execution.id > cursor, 'Pagination cursor was not exclusive or ordered');
        assert(!seen.has(execution.id), 'Pagination duplicated an execution');
        seen.add(execution.id);
        cursor = execution.id;
        execution.plan.actions[0].prompt = 'changed pagination output';
      }
      assert(++pages <= MAX_PAGES, 'Fixture pagination did not terminate');
    }
    assert.deepEqual([...seen].filter(id => tracked.has(id)), expectedIds, 'Pagination missed active fixtures');
    assert.deepEqual(await stores[0].getExecution(cloneExpected.id), cloneExpected, 'List output mutated stored record');
    for (const limit of [0, 65, 1.5]) await assert.rejects(stores[1].listActiveExecutions(limit));

    const consoleTime = Date.now() - 40_000;
    const olderActive = make('console-old-active', consoleTime);
    const newerTerminal = make('console-new-terminal', consoleTime + 30_000);
    const ties = [make('console-tie-a', consoleTime + 20_000), make('console-tie-b', consoleTime + 20_000)];
    for (const record of [olderActive, newerTerminal, ...ties]) await stores[0].createExecutionIfAbsent(record);
    await stores[0].compareAndSetExecution(next(newerTerminal, { status: 'cancelled' }), 1);
    const consoleChats = [original.chatId, isolated.chatId, cloneExpected.chatId,
      olderActive.chatId, newerTerminal.chatId, ...ties.map(record => record.chatId)];
    const consoleExpected = (await Promise.all([...tracked.keys()].map(id => stores[0].getExecution(id))))
      .filter(execution => execution && consoleChats.includes(execution.chatId))
      .sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active') ||
        b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    assert(consoleExpected.findIndex(record => record.id === olderActive.id) < consoleExpected.findIndex(record => record.id === newerTerminal.id),
      'Fixture must distinguish active priority from creation time');
    const tieIds = ties.map(record => record.id).sort().reverse();
    assert.deepEqual(consoleExpected.filter(record => tieIds.includes(record.id)).map(record => record.id), tieIds);
    for (const limit of [1, 2, 13]) {
      assert.deepEqual(await stores[1].listRecentExecutions(consoleChats, limit), consoleExpected.slice(0, limit),
        'Console list must filter chats before LIMIT and prioritize active then newest/id');
    }
    assert.deepEqual(await stores[1].listRecentExecutions([], 13), [], 'Empty allowed chats exposed plans');
    const consoleClone = await stores[0].listRecentExecutions(consoleChats, 13);
    consoleClone[0].plan.actions[0].prompt = 'mutated console caller';
    assert.deepEqual(await stores[1].listRecentExecutions(consoleChats, 13), consoleExpected);
    for (const limit of [0, 65, 1.5]) await assert.rejects(stores[1].listRecentExecutions(consoleChats, limit));

    reopened = await reopenStore();
    assert(!stores.includes(reopened), 'Reconnect verification must use a new instance');
    assert.deepEqual(await reopened.getExecution(original.id), terminal, 'Terminal record lost on a newly opened store');
    assert.deepEqual(await reopened.getExecution(successor.id), successor, 'Active record lost on a newly opened store');
    assert.deepEqual(await reopened.getExecution(cloneExpected.id), cloneExpected, 'Nested plan lost on reopen');
    assert.deepEqual(await reopened.listRecentExecutions(consoleChats, 13), consoleExpected, 'Console list lost persisted plans on reconnect');
  } catch (error) { failure = error; }

  const cleanupErrors = [], persistedIds = [];
  for (const id of tracked.keys()) {
    try {
      const execution = await stores[0].getExecution(id);
      if (execution) persistedIds.push(id);
      if (execution?.status === 'active') {
        assert(await stores[0].compareAndSetExecution(next(execution, { status: 'cancelled' }), execution.revision),
          'Fixture changed during cleanup; helper must run before any scheduler starts');
      }
    } catch (error) { cleanupErrors.push(error); }
  }
  if (reopened) {
    try { await reopened.close(); } catch (error) { cleanupErrors.push(error); }
  }
  if (failure || cleanupErrors.length) {
    throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors],
      `Persistent execution store verification failed: ${(failure ?? cleanupErrors[0]).message}`);
  }
  console.log('PASS execution store create/CAS races, immutable claims and authorization, terminal/reopen, chat isolation, pagination and clones');
  console.log('PASS real PostgreSQL console list filters before LIMIT, active/newest/id ordering, empty allowlist and reconnect');
  return { executionIds: persistedIds, chatPrefix: `${FIXTURE_PREFIX}${fixtureTag.slice(0, 8)}` };
}
