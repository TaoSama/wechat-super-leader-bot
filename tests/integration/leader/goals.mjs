import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { closeTestWebSocket, withTestCleanup } from '../../support/cleanup.mjs';
import { fixtureHistory } from './confirmation-fixture.mjs';

export const GOAL_NODE = 'goal-fixture-node';
export const GOAL_CHAT = 'goal-fixture-chat';
const PREFIX = 'goal-fixture:';
const SESSION = 'goal-existing-session';
const TICK_WINDOW_MS = 2300;
const HEARTBEAT_MS = 500;
const REQUEST_TIMEOUT_MS = 5000;
const MAX_SNAPSHOTS = 32;
const RESULT_PREFIX = 'PRIVATE_GOAL_RESULT:';

// Match the pure decision tool AND this fixture's authorization. A regular model
// request (including other fixtures) is never intercepted by a JSON-like string.
export function goalModelCall(last, tools = []) {
  const names = tools.map(tool => tool.name ?? tool.function?.name);
  if (names.length === 1 && names[0] === 'decide_goal') {
    const input = JSON.parse(last.content);
    if (!input.authorization?.objective?.startsWith(PREFIX)) return null;
    assert.equal(input.kind, 'untrusted_goal_observations');
    const scenario = input.authorization.objective.slice(PREFIX.length);
    assert(input.actions.every(action => action.status === 'completed' && action.result));
    if (input.actions.length === 0) return { name: 'decide_goal', args: {
      type: 'next', target: 1, prompt: `${PREFIX}${scenario}:baseline`, sourceActions: [], reason: '先取得精确基准' } };
    if (input.actions.length === 1) {
      const branch = input.actions[0].result.excerpt.includes('branch=B') ? 'B' : 'A';
      return { name: 'decide_goal', args: { type: 'next', target: 1,
        prompt: `${PREFIX}${scenario}:different-check-${branch}`, sourceActions: [1], reason: '后继任务由本目标精确结果动态决定' } };
    }
    assert.equal(input.actions.length, 2);
    assert(input.actions[1].result.excerpt.includes('verified-final'));
    return { name: 'decide_goal', args: { type: 'complete', criteria: [{ criterion: 1, actions: [2] }], reason: '记录的最终精确证据支持条件；这是模型判断' } };
  }
  if (last.type === 'function_call_output' || typeof last.content !== 'string' || !last.content.startsWith(PREFIX)) return null;
  const scenario = last.content.slice(PREFIX.length);
  if (scenario.startsWith('query:')) return { name: 'get_goal_progress', args: { goalId: scenario.slice(6) } };
  return { name: 'propose_goal', args: { objective: PREFIX + scenario, criteria: ['核查最终证据'],
    targets: [{ nodeId: GOAL_NODE, sessionId: SESSION }], constraints: '仅合成测试；只读；不扩张权限',
    maxActions: scenario === 'action-budget' ? 1 : 3, maxDecisions: scenario === 'decision-budget' ? 1 : 4,
    durationMinutes: 30, shareResults: true } };
}

// Real Controller HTTP/model protocol, durable PG records and synthetic WS only.
export async function verifyGoals({ WebSocket, base, request, nodeToken, store, restart, waitFor }) {
  const { goalRequestId } = await import('../../../controller/dist/leader/goals/goal.js');
  const delivered = [], errors = [], acknowledgements = [], goalIds = [];
  const recordedResults = [];
  let socket, heartbeat, probe, sessionStatus = 'idle';
  const healthy = () => { if (errors.length) throw errors[0]; };
  const write = frame => {
    assert(socket?.readyState === WebSocket.OPEN, 'Goal fixture socket is not open');
    if (frame.type === 'result') recordedResults.push({ ...frame, nodeId: GOAL_NODE });
    socket.send(JSON.stringify(frame), error => { if (error) errors.push(error); });
  };
  const frame = type => ({ type, ...(type === 'hello' ? { version: 1, nodeId: GOAL_NODE } : {}), skills: [],
    sessions: [{ id: SESSION, provider: 'codex-app', title: 'Synthetic existing goal conversation', cwd: '/fixture',
      status: sessionStatus, loaded: true, capabilities: ['read', 'send'], observedAt: new Date().toISOString() }] });
  const publish = async () => {
    write(frame('heartbeat'));
    await waitFor(async () => { healthy(); return (await request('/v1/status')).body.sessions.some(item =>
      item.nodeId === GOAL_NODE && item.id === SESSION && item.status === sessionStatus); }, 'Goal target qualification persisted');
  };
  const connect = async () => {
    socket = new WebSocket(base.replace('http:', 'ws:') + '/v1/daemon', { headers: { authorization: 'Bearer ' + nodeToken } });
    socket.on('error', error => errors.push(error));
    await once(socket, 'open');
    socket.on('message', raw => {
      try {
        const item = JSON.parse(raw.toString());
        if (item.type === 'read_history') {
          const session = frame('heartbeat').sessions.find(session => session.id === item.sessionId);
          assert(session, 'History requested from an unknown goal session');
          write(fixtureHistory(item, session, delivered, recordedResults));
        } else if (item.type === 'command') {
          assert.equal(item.nodeId, GOAL_NODE); assert.equal(item.sessionId, SESSION); assert.equal(item.action, 'send');
          assert.equal(item.sendRoute, 'control-socket');
          for (const key of ['sourceActions', 'authorization', 'lease', 'target']) assert(!Object.hasOwn(item, key));
          delivered.push(item);
          write({ type: 'result', commandId: item.commandId, status: 'accepted', turnId: 'goal-turn-' + item.commandId });
        } else if (item.type === 'result_ack') acknowledgements.push(item);
      } catch (error) { errors.push(error); }
    });
    write(frame('hello'));
    await publish();
    heartbeat = setInterval(() => { try { write(frame('heartbeat')); } catch (error) { errors.push(error); } }, HEARTBEAT_MS);
  };
  const disconnect = async () => {
    clearInterval(heartbeat); heartbeat = undefined;
    const owned = socket; socket = undefined;
    await closeTestWebSocket(owned);
  };
  const message = (text, messageId = randomUUID(), chatId = GOAL_CHAT) => request('/v1/messages', { chatId, messageId, text });
  const waitStatus = (id, status) => waitFor(async () => { healthy(); return (await store.getGoal(id))?.status === status; }, 'Goal becomes ' + status);
  const waitAction = async (goal, index) => {
    let command;
    await waitFor(async () => { healthy(); command = await store.findCommandByRequestId(goalRequestId(goal, index)); return command?.status === 'accepted'; },
      `Goal ${goal.proposal.objective} action ${index + 1} has exact acceptance`);
    assert.equal(delivered.filter(item => item.commandId === command.commandId).length, 1, 'A durable goal action was sent twice');
    return command;
  };
  const receipt = async (command, output) => {
    const before = acknowledgements.filter(item => item.commandId === command.commandId && item.status === 'completed').length;
    write({ type: 'result', commandId: command.commandId, status: 'completed', turnId: command.turnId, output });
    await waitFor(() => { healthy(); return acknowledgements.filter(item => item.commandId === command.commandId && item.status === 'completed').length > before; },
      'Goal exact completion committed before acknowledgement');
  };
  const propose = async scenario => {
    const before = delivered.length;
    const preview = await message(PREFIX + scenario);
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    const pending = (await store.getLeaderState(GOAL_CHAT)).data.pendingGoal;
    assert(pending && preview.body.text.includes('回复“确认”即可开始'), 'Goal preview omitted its confirmation instruction');
    assert(!preview.body.text.includes(pending.id), 'Goal preview exposed its internal authorization UUID');
    assert.equal(await store.getGoal(pending.id), null, 'Preview published a schedulable goal');
    assert.equal(await store.findCommandByRequestId(goalRequestId({ id: pending.id, chatId: GOAL_CHAT }, 0)), null);
    assert.equal(delivered.length, before);
    await probe.absent(pending.id);
    const confirmed = await message('执行');
    assert.equal(confirmed.status, 200);
    const goal = await store.getGoal(pending.id);
    assert(goal && goal.status === 'active'); goalIds.push(goal.id);
    return { goal, first: await waitAction(goal, 0), confirmation: confirmed };
  };
  const verifyFinal = async (goal, first, branch) => {
    await receipt(first, `${RESULT_PREFIX} branch=${branch}; exact baseline`);
    const second = await waitAction(goal, 1);
    const durable = await store.getGoal(goal.id);
    assert.notEqual(durable.actions[0].prompt, durable.actions[1].prompt, 'Second action is a replay of the first');
    assert(durable.actions[1].prompt.endsWith('different-check-' + branch), 'Second action ignored the actual first result');
    assert.deepEqual(durable.actions[1].sourceActions, [1]);
    assert.equal(durable.actions[1].input.sources[0].commandId, first.commandId);
    assert(second.prompt.includes(JSON.stringify(`${RESULT_PREFIX} branch=${branch}; exact baseline`)));
    await receipt(second, 'verified-final branch=' + branch);
    await waitStatus(goal.id, 'completed');
    const completed = await store.getGoal(goal.id);
    assert.equal(completed.decisionAttempts, 3);
    assert.equal(completed.decisions.at(-1).decision.type, 'complete');
    const publicGoal = await probe.goal(goal.id, 'completed', ['completed', 'completed']);
    assert.deepEqual(publicGoal.criteria[0], { index: 1, text: '核查最终证据', supported: true, actions: [2] });
    assert(!JSON.stringify(publicGoal).includes(RESULT_PREFIX), 'Goal public projection exposed a result body');
    return durable.actions[1].prompt;
  };
  return withTestCleanup(async () => {
    await connect(); probe = await openGoalConsoleProbe({ base, request, waitFor });
    const a = await propose('chain-a');
    await delay(TICK_WINDOW_MS); healthy();
    assert.equal((await store.getGoal(a.goal.id)).decisionAttempts, 1, 'accepted receipt advanced the model');
    assert.equal((await store.getGoal(a.goal.id)).actions.length, 1);
    await probe.goal(a.goal.id, 'active', ['accepted']);
    const duplicate = await message(`确认目标 ${a.goal.id}`);
    assert.equal(duplicate.status, 200);
    assert.equal(delivered.length, 1, 'Duplicate confirmation replayed first task');
    const promptA = await verifyFinal(a.goal, a.first, 'A');
    const b = await propose('chain-b');
    const promptB = await verifyFinal(b.goal, b.first, 'B');
    assert.notEqual(promptA, promptB, 'Independent result branches did not change the dynamic follow-up');
    console.log('PASS one HTTP confirmation, no new user messages: accepted waits; two distinct precise results select different next tasks and exact complete; duplicate confirms never resend');

    const pendingRestart = await propose('restart');
    sessionStatus = 'active'; await publish();
    await receipt(pendingRestart.first, `${RESULT_PREFIX} branch=B; exact baseline`);
    await waitFor(async () => (await store.getGoal(pendingRestart.goal.id)).actions.length === 2, 'Dynamic second action persisted while target is busy');
    const frozen = await store.getGoal(pendingRestart.goal.id);
    assert.equal(frozen.actions[1].attempt, undefined, 'Busy target consumed permanent send claim');
    await delay(TICK_WINDOW_MS);
    assert.equal((await store.getGoal(frozen.id)).decisionAttempts, 2, 'Waiting task repeatedly called model');
    await probe.close(); probe = undefined;
    await disconnect(); await restart(); sessionStatus = 'idle'; await connect();
    assert.deepEqual((await store.getGoal(frozen.id)).actions[1].input, frozen.actions[1].input, 'Restart changed the frozen action/result input');
    probe = await openGoalConsoleProbe({ base, request, waitFor });
    const second = await waitAction(frozen, 1);
    assert.equal(delivered.filter(item => item.commandId === pendingRestart.first.commandId).length, 1);
    await receipt(second, 'verified-final branch=B'); await waitStatus(frozen.id, 'completed');
    await probe.goal(frozen.id, 'completed', ['completed', 'completed']);
    console.log('PASS restart preserves pending dynamic action/evidence, busy target waits without claim/model churn, original action never replayed');

    const unknown = await propose('unknown');
    await disconnect();
    await waitFor(async () => (await store.getCommand(unknown.first.commandId)).status === 'uncertain',
      'Disconnect uncertainty is durably committed before the next synthetic node generation');
    await connect();
    await waitStatus(unknown.goal.id, 'blocked');
    const count = delivered.length;
    await message(`确认目标 ${unknown.goal.id}`); await delay(TICK_WINDOW_MS);
    assert.equal(delivered.length, count, 'Unknown command was retried under a new request ID');
    assert.equal((await store.getGoal(unknown.goal.id)).actions.length, 1);
    await probe.goal(unknown.goal.id, 'blocked', ['uncertain']);
    await message('取消目标'); await waitStatus(unknown.goal.id, 'cancelled');
    // Cancelling authorization cannot declare the original native turn finished.
    // Its late exact completion releases the target FIFO before another explicit goal.
    await receipt(unknown.first, `${RESULT_PREFIX} branch=A; late exact completion after cancellation`);
    assert.equal((await store.getGoal(unknown.goal.id)).status, 'cancelled');
    assert.equal((await store.getGoal(unknown.goal.id)).actions.length, 1);
    assert.equal(delivered.length, count, 'Late completion resumed a cancelled goal');
    await probe.goal(unknown.goal.id, 'cancelled', ['completed']);

    const cancelled = await propose('cancel');
    await message('取消目标'); await waitStatus(cancelled.goal.id, 'cancelled');
    await receipt(cancelled.first, `${RESULT_PREFIX} branch=A; exact baseline`);
    await delay(TICK_WINDOW_MS);
    assert.equal((await store.getGoal(cancelled.goal.id)).actions.length, 1, 'Cancel admitted a new successor');
    assert.equal(delivered.filter(item => item.commandId === cancelled.first.commandId).length, 1);
    for (const scenario of ['action-budget', 'decision-budget']) {
      const budget = await propose(scenario);
      await receipt(budget.first, `${RESULT_PREFIX} branch=A; exact baseline`);
      await waitStatus(budget.goal.id, 'blocked');
      assert.equal((await store.getGoal(budget.goal.id)).actions.length, 1);
      await message('取消目标'); await waitStatus(budget.goal.id, 'cancelled');
    }
    console.log('PASS HTTP unknown never retries; cancellation preserves admitted native turn but prohibits successors; actual action and model-decision budgets stop');
    await probe.revoke();
    console.log('PASS goals HTTP/SSE share the exact allowlisted public projection, hide raw result/lease/claims, and console cookies gain no write authority');
    return goalIds;
  }, [
    { label: 'goal console SSE', cleanup: () => probe?.close() },
    { label: 'goal synthetic WS', cleanup: disconnect },
    { label: 'unfinished goal fixtures', cleanup: async () => {
      for (const id of goalIds) {
        const goal = await store.getGoal(id);
        if (goal && ['active', 'blocked'].includes(goal.status)) assert(await store.compareAndSetGoal({ ...goal, status: 'cancelled', lease: undefined, revision: goal.revision + 1 }, goal.revision));
      }
    } },
  ]);
}

function assertGoalProjection(group) {
  assert.deepEqual(Object.keys(group).sort(), ['hasMore', 'items', 'limit', 'observedAt']);
  assert.equal(group.limit, 12); assert(Number.isSafeInteger(group.observedAt));
  assert.equal(typeof group.hasMore, 'boolean'); assert(group.items.length <= 12);
  const fields = ['actions', 'createdAt', 'criteria', 'decisionAttempts', 'expiresAt', 'id', 'maxActions', 'maxDecisions', 'objective', 'objectiveTruncated', 'reason', 'status', 'targets'];
  const actionKeys = new Set(['index', 'target', 'prompt', 'promptTruncated', 'sourceActions', 'status', 'commandId', 'turnId']);
  for (const goal of group.items) {
    assert.deepEqual(Object.keys(goal).sort(), fields);
    assert(goal.actions.length <= goal.maxActions); assert(goal.decisionAttempts <= goal.maxDecisions);
    for (const action of goal.actions) assert(Object.keys(action).every(key => actionKeys.has(key)), 'Goal private durable fields leaked');
    for (const target of goal.targets) assert.deepEqual(Object.keys(target).sort(), ['nodeId', 'sessionId']);
  }
}

// The existing plan probe intentionally hides its cookie and only exposes plan
// assertions, so this goal probe uses the same real exchange/SSE handlers.
async function openGoalConsoleProbe({ base, request, waitFor }) {
  const issued = await request('/v1/console-links', { requestId: 'goal-console-' + randomUUID() });
  assert.equal(issued.status, 200);
  const token = new URLSearchParams(new URL(issued.body.url).hash.slice(1)).get('login');
  assert(token);
  const exchange = await fetch(base + '/auth/exchange', { method: 'POST', headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ token }), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  assert.equal(exchange.status, 200);
  const cookie = exchange.headers.get('set-cookie')?.split(';')[0]; assert(cookie); await exchange.arrayBuffer();
  const get = (path, init = {}) => fetch(base + path, { ...init, headers: { cookie, origin: base, ...init.headers }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  for (const path of ['/v1/messages', '/v1/commands']) {
    const denied = await get(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(denied.status, 401, 'Goal visibility broadened console write authority'); await denied.arrayBuffer();
  }
  const abort = new AbortController(), snapshots = [], errors = [];
  let reader, reading, finished = false, revoked = false;
  try {
    const deadline = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
    let response;
    try { response = await fetch(base + '/v1/events', { headers: { cookie, origin: base }, signal: abort.signal }); }
    finally { clearTimeout(deadline); }
    assert.equal(response.status, 200); reader = response.body.getReader();
    reading = (async () => {
      const decoder = new TextDecoder(); let buffer = '';
      try {
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          buffer += decoder.decode(value, { stream: true }); let end;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            if (frame.startsWith('event: auth-expired\n')) revoked = true;
            if (!frame.startsWith('event: status\n')) continue;
            const line = frame.split('\n').find(item => item.startsWith('data: ')); assert(line);
            const group = JSON.parse(line.slice(6)).goals; assertGoalProjection(group);
            snapshots.push(group); if (snapshots.length > MAX_SNAPSHOTS) snapshots.shift();
          }
        }
      } catch (error) { if (!abort.signal.aborted) errors.push(error); }
      finally { finished = true; }
    })();
    await waitFor(() => { if (errors.length) throw errors[0]; return snapshots.length > 0; }, 'Initial authenticated goal SSE');
  } catch (error) { abort.abort(); if (reading) await reading; reader?.releaseLock(); throw error; }
  return {
    async goal(id, status, actionStatuses) {
      let item;
      await waitFor(async () => {
        if (errors.length) throw errors[0];
        const response = await get('/v1/status'); assert.equal(response.status, 200);
        const group = (await response.json()).goals; assertGoalProjection(group);
        item = group.items.find(goal => goal.id === id);
        return item?.status === status && JSON.stringify(item.actions.map(action => action.status)) === JSON.stringify(actionStatuses);
      }, 'HTTP goal precise state ' + status);
      await waitFor(async () => {
        if (errors.length) throw errors[0];
        if (finished) {
          const response = await get('/v1/status');
          const body = await response.text();
          const snapshot = JSON.parse(body);
          const sections = Object.fromEntries(Object.entries(snapshot).map(([key, value]) => [key, Buffer.byteLength(JSON.stringify(value))]));
          throw new Error(`Goal SSE closed before ${status} ${JSON.stringify(actionStatuses)} update; revoked=${revoked}; snapshots=${snapshots.length}; HTTP=${response.status}; bytes=${Buffer.byteLength(body)}; sections=${JSON.stringify(sections)}`);
        }
        return snapshots.some(group => group.items.some(goal => goal.id === id && JSON.stringify(goal) === JSON.stringify(item)));
      }, 'SSE matches the HTTP goal projection');
      return item;
    },
    async absent(id) {
      const response = await get('/v1/status'); assert.equal(response.status, 200);
      const group = (await response.json()).goals; assertGoalProjection(group);
      assert(!group.items.some(goal => goal.id === id)); assert(!snapshots.some(group => group.items.some(goal => goal.id === id)));
    },
    async revoke() {
      const response = await get('/auth/logout', { method: 'POST' }); assert.equal(response.status, 200); await response.arrayBuffer();
      await waitFor(() => { if (errors.length) throw errors[0]; return revoked && finished; }, 'Logout closes goal SSE');
      const denied = await get('/v1/status'); assert.equal(denied.status, 401); await denied.arrayBuffer();
    },
    async close() { abort.abort(); await reading; reader.releaseLock(); if (errors.length) throw errors[0]; },
  };
}
