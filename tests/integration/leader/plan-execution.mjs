import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { openPlanConsoleProbe, assertProjection } from './plan-console.mjs';
import { fixtureHistory } from './confirmation-fixture.mjs';

export const PLAN_NODE = 'plan-fixture-node';
export const PLAN_CHAT = 'plan-fixture-chat';
const PREFIX = 'plan-fixture:';
const HEARTBEAT_MS = 500;
const TWO_TICKS_MS = 4200;
const ONE_TICK_MS = 2200;
const SESSION_A = 'plan-session-a';
const SESSION_B = 'plan-session-b';
const skill = { id: 'c'.repeat(64), digest: 'd'.repeat(64), name: 'plan-fixture-skill',
  description: 'Synthetic fixture only', path: '/fixture/SKILL.md' };

export function planModelCall(text) {
  if (typeof text !== 'string' || !text.startsWith(PREFIX)) return null;
  const scenario = text.slice(PREFIX.length);
  if (scenario.startsWith('query:')) return { name: 'get_plan_progress', args: { planId: scenario.slice(6) } };
  const action = (suffix, sessionId, dependsOn) => ({
    nodeId: PLAN_NODE, sessionId, prompt: PREFIX + scenario + ':' + suffix, dependsOn,
    ...(scenario === 'skills' ? { skills: [{ id: skill.id, digest: skill.digest }] } : {}),
  });
  return { name: 'propose_plan', args: { actions: [
    action('A', SESSION_A, []),
    action('B', scenario === 'same-session' ? SESSION_A : SESSION_B, [1]),
  ] } };
}

// Real HTTP/model protocol, real PostgreSQL and WS with deliberately controlled
// completion. inspect_turn is recorded, never auto-completed by this fixture.
export async function verifyPlanExecution({ WebSocket, base, request, nodeToken, store, restart, waitFor }) {
  const { createExecution, executionRequestId, EXECUTION_CLAIM_MS } = await import('../../../controller/dist/leader/plans/execution.js');
  const deliveries = [], inspections = [], acknowledgements = [], errors = [], executionIds = [];
  const recordedResults = [];
  let socket, timer, consoleProbe, generation = 0;
  let catalog = [skill];
  const sessions = [SESSION_A, SESSION_B].map(id => ({
    id, provider: 'codex-app', cwd: '/fixture', status: 'idle', loaded: true, capabilities: ['read', 'send'],
  }));
  const assertHealthy = () => { if (errors.length) throw errors[0]; };
  const frame = type => ({ type, ...(type === 'hello' ? { version: 1, nodeId: PLAN_NODE } : {}),
    sessions: sessions.map(session => ({ ...session, title: 'fixture-' + generation, observedAt: new Date().toISOString() })),
    skills: catalog });
  const write = message => {
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('Plan fixture socket is not open');
    if (message.type === 'result') recordedResults.push({ ...message, nodeId: PLAN_NODE });
    socket.send(JSON.stringify(message), error => { if (error) errors.push(error); });
  };
  const publish = async () => {
    generation++;
    write(frame('heartbeat'));
    await waitFor(async () => {
      assertHealthy();
      const snapshot = (await request('/v1/status')).body.sessions.filter(item => item.nodeId === PLAN_NODE);
      return snapshot.length === sessions.length && snapshot.every(item => item.title === 'fixture-' + generation);
    }, 'Plan fixture heartbeat persisted');
  };
  const connect = async () => {
    socket = new WebSocket(base.replace('http:', 'ws:') + '/v1/daemon',
      { headers: { authorization: 'Bearer ' + nodeToken } });
    socket.on('error', error => errors.push(error));
    await once(socket, 'open');
    socket.on('message', raw => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.type === 'read_history') {
          const session = frame('heartbeat').sessions.find(item => item.id === message.sessionId);
          assert(session, 'History requested from an unknown plan session');
          write(fixtureHistory(message, session, deliveries, recordedResults));
        } else if (message.type === 'command') {
          assert.equal(message.nodeId, PLAN_NODE);
          assert.equal(message.action, 'send');
          assert(sessions.some(session => session.id === message.sessionId));
          assert(!Object.hasOwn(message, 'dependsOn'), 'Orchestration fields leaked onto native command');
          deliveries.push(message);
          write({ type: 'result', commandId: message.commandId, status: 'accepted',
            turnId: 'turn-' + message.commandId, output: 'fixture accepted, not completed' });
        } else if (message.type === 'inspect_turn') inspections.push(message);
        else if (message.type === 'result_ack') acknowledgements.push(message);
      } catch (error) { errors.push(error); }
    });
    write(frame('hello'));
    await publish();
    timer = setInterval(() => {
      try { if (socket?.readyState === WebSocket.OPEN) write(frame('heartbeat')); }
      catch (error) { errors.push(error); }
    }, HEARTBEAT_MS);
  };
  const disconnect = async () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    const current = socket;
    socket = undefined;
    if (current && current.readyState !== WebSocket.CLOSED) {
      const closed = once(current, 'close');
      current.close();
      await closed;
    }
  };
  const message = (messageId, text, chatId = PLAN_CHAT) => request('/v1/messages', { chatId, messageId, text });
  const command = (scenario, suffix) => deliveries.filter(item => item.prompt === PREFIX + scenario + ':' + suffix);
  const acknowledged = (commandId, status, turnId) => acknowledgements.filter(item =>
    item.commandId === commandId && item.status === status && item.turnId === turnId).length;
  const receipt = async (item, status = 'completed') => {
    const turnId = 'turn-' + item.commandId;
    const before = acknowledged(item.commandId, status, turnId);
    write({ type: 'result', commandId: item.commandId, turnId, status, output: 'exact fixture ' + status });
    await waitFor(() => {
      assertHealthy();
      return acknowledged(item.commandId, status, turnId) > before;
    }, 'Exact result committed before result_ack');
  };
  const waitCommand = async (scenario, suffix) => {
    await waitFor(async () => {
      assertHealthy();
      const item = command(scenario, suffix)[0];
      return item && (await store.getCommand(item.commandId))?.status === 'accepted';
    }, scenario + ' ' + suffix + ' accepted');
    assert.equal(command(scenario, suffix).length, 1, 'Step was submitted more than once');
    return command(scenario, suffix)[0];
  };
  const waitStatus = (id, status) => waitFor(async () => (await store.getExecution(id))?.status === status,
    'Execution became ' + status);
  const noSuccessor = async (execution, scenario, duration = ONE_TICK_MS) => {
    await delay(duration);
    assertHealthy();
    assert.equal(command(scenario, 'B').length, 0, 'Blocked successor was dispatched');
    assert.equal((await store.getExecution(execution.id)).attempts[1], null, 'Waiting successor consumed an attempt');
  };
  const plan = async scenario => {
    const count = deliveries.length;
    const preview = await message('plan-' + scenario, PREFIX + scenario);
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert(preview.body.text.includes('尚未派发'), JSON.stringify(preview.body));
    assert.equal(deliveries.length, count, 'Preview dispatched a command');
    const pending = (await store.getLeaderState(PLAN_CHAT)).data.pending;
    assert(pending, 'Preview did not persist a pending plan');
    const assertUnconfirmed = async () => {
      assert.equal(await store.getExecution(pending.id), null, 'Preview created a schedulable execution before confirmation');
      for (const index of pending.actions.keys()) {
        assert.equal(await store.findCommandByRequestId(executionRequestId({ id: pending.id, chatId: PLAN_CHAT }, index)),
          null, 'Preview created a dispatch command before confirmation');
      }
      assert.equal(deliveries.length, count, 'Background tick sent a preview before confirmation');
      if (consoleProbe) await consoleProbe.assertAbsent(pending.id);
    };
    await assertUnconfirmed();
    if (scenario === 'chain') {
      await delay(TWO_TICKS_MS);
      assertHealthy();
      await assertUnconfirmed();
    }
    const confirmation = await message('confirm-' + scenario, '确认执行');
    assert.equal(confirmation.status, 200, JSON.stringify(confirmation.body));
    const execution = await store.getLatestExecution(PLAN_CHAT);
    assert(execution && execution.status === 'active', JSON.stringify(confirmation.body));
    executionIds.push(execution.id);
    const first = await waitCommand(scenario, 'A');
    assert.equal(command(scenario, 'B').length, 0);
    return { execution, first, confirmation };
  };
  const finish = async (execution, scenario) => {
    const last = await waitCommand(scenario, 'B');
    assert.equal(last.sendRoute, execution.plan.actions[1].sendRoute, 'Wire changed the frozen send route');
    assert.deepEqual(last.skills ?? [], execution.plan.actions[1].skills ?? [], 'Wire changed the frozen skill digest');
    await receipt(last);
    await waitStatus(execution.id, 'completed');
    assert.equal(command(scenario, 'A').length, 1);
    assert.equal(command(scenario, 'B').length, 1);
  };
  const restartAndConnect = async allowed => {
    await disconnect();
    await restart(allowed);
    await connect();
  };
  try {
    await connect();
    consoleProbe = await openPlanConsoleProbe({ base, request, waitFor });
    const chain = await plan('chain');
    await noSuccessor(chain.execution, 'chain', TWO_TICKS_MS);
    await consoleProbe.assertPlan(chain.execution.id, 'active', ['accepted', 'waiting']);
    const progress = await message('query-chain', PREFIX + 'query:' + chain.execution.id);
    assert.equal(progress.status, 200);
    assert(progress.body.text.includes('accepted') && progress.body.text.includes('waiting'));
    const denied = await message('foreign-chain', PREFIX + 'query:' + chain.execution.id, 'test-chat');
    assert.equal(denied.status, 200);
    assert(denied.body.text.includes('does not belong'), 'Plan leaked across chats');
    const badAckCount = acknowledgements.length;
    for (const turnId of [undefined, 'wrong-turn']) write({ type: 'result', commandId: chain.first.commandId,
      status: 'completed', ...(turnId ? { turnId } : {}), output: 'must be rejected' });
    await noSuccessor(chain.execution, 'chain');
    assert.equal(acknowledgements.length, badAckCount, 'Invalid completion received acknowledgement');
    assert.equal((await store.getCommand(chain.first.commandId)).status, 'accepted');
    await receipt(chain.first);
    await finish(chain.execution, 'chain');
    await consoleProbe.assertPlan(chain.execution.id, 'completed', ['completed', 'completed']);
    assert.deepEqual((await message('confirm-chain', '确认执行')).body, chain.confirmation.body);
    await receipt(chain.first);
    await delay(ONE_TICK_MS);
    assert.equal(command('chain', 'B').length, 1);
    console.log('PASS persistent plan preview zero writes, accepted != completed, rejected wrong/missing turns, exact dependency, chat isolation and duplicate confirmation/result');

    const same = await plan('same-session');
    sessions[0].status = 'active';
    await publish();
    await receipt(same.first);
    await noSuccessor(same.execution, 'same-session');
    assert.equal((await store.getExecution(same.execution.id)).status, 'active');
    sessions[0].status = 'idle';
    await publish();
    await finish(same.execution, 'same-session');
    console.log('PASS same-session successor waits for idle heartbeat without burning its claim');

    const cancelled = await plan('cancelled');
    const cancellation = await message('cancel-cancelled', '先别跑后面的任务');
    assert.equal(cancellation.status, 200);
    assert(cancellation.body.text.includes('不会停止原会话'));
    await waitStatus(cancelled.execution.id, 'cancelled');
    await consoleProbe.assertPlan(cancelled.execution.id, 'cancelled', ['accepted', 'cancelled']);
    await receipt(cancelled.first);
    await noSuccessor(cancelled.execution, 'cancelled');
    await consoleProbe.assertPlan(cancelled.execution.id, 'cancelled', ['completed', 'cancelled']);
    await consoleProbe.revoke();
    await consoleProbe.close(); consoleProbe = undefined;
    console.log('PASS real PG-backed console HTTP/SSE shows confirmed exact plans, accepted != completed, cancellation receipts; restricted cookie writes and logout revocation');
    console.log('PASS natural-language cancellation persists; late predecessor completion never starts a successor');

    const recovered = await plan('restart');
    const deliveriesBefore = deliveries.length;
    await restartAndConnect(true);
    assert.equal((await store.getCommand(recovered.first.commandId)).status, 'uncertain');
    await waitFor(() => inspections.some(item => item.commandId === recovered.first.commandId &&
      item.turnId === 'turn-' + recovered.first.commandId), 'Restart inspects exact native turn');
    await noSuccessor(recovered.execution, 'restart');
    assert.equal(deliveries.length, deliveriesBefore, 'Restart replayed original command');
    await receipt(recovered.first);
    await finish(recovered.execution, 'restart');
    console.log('PASS real Controller restart only inspects uncertain exact turn, then resumes successor without replaying predecessor');

    const now = Date.now() - EXECUTION_CLAIM_MS - 1000;
    sessions[0].status = 'active';
    await publish();
    const crash = createExecution(PLAN_CHAT, { id: randomUUID(), expiresAt: Date.now() + 60_000,
      actions: [{ nodeId: PLAN_NODE, sessionId: SESSION_A, prompt: PREFIX + 'crash:A',
        sendRoute: 'control-socket', dependsOn: [] }] }, now);
    crash.attempts[0] = { token: randomUUID(), startedAt: now, expiresAt: now + EXECUTION_CLAIM_MS };
    const unclaimed = { ...crash, attempts: [null] };
    await store.createExecutionIfAbsent(unclaimed);
    assert(await store.compareAndSetExecution({ ...crash, revision: 2 }, 1), 'Crash fixture claim lost unexpectedly');
    executionIds.push(crash.id);
    sessions[0].status = 'idle';
    await restartAndConnect(true);
    await delay(TWO_TICKS_MS);
    assert.equal(command('crash', 'A').length, 0, 'Missing command after expired claim was replayed');
    const crashView = await message('query-crash', PREFIX + 'query:' + crash.id);
    assert(crashView.body.text.includes('uncertain'), JSON.stringify(crashView.body));
    await message('cancel-crash', '取消计划');
    await waitStatus(crash.id, 'cancelled');
    console.log('PASS durable expired claim without command stays uncertain across restart; no speculative replay');

    for (const scenario of ['route', 'skills']) {
      const frozen = await plan(scenario);
      if (scenario === 'route') {
        const observed = Date.now();
        sessions[1].sendAvailability = { route: 'desktop-owner', state: 'ready',
          observedAt: new Date(observed).toISOString(), validUntil: new Date(observed + 45_000).toISOString() };
      } else catalog = [{ ...skill, digest: 'e'.repeat(64) }];
      await publish();
      await receipt(frozen.first);
      await noSuccessor(frozen.execution, scenario);
      assert.equal((await store.getExecution(frozen.execution.id)).status, 'active');
      delete sessions[1].sendAvailability;
      catalog = [skill];
      await publish();
      await finish(frozen.execution, scenario);
    }
    console.log('PASS frozen route and skill digest changes wait without claim or fallback; original qualification restores progress');

    const revoked = await plan('revoked');
    await restartAndConnect(false);
    await waitStatus(revoked.execution.id, 'failed');
    const hiddenPlans = (await request('/v1/status')).body.executions;
    assertProjection(hiddenPlans);
    assert(hiddenPlans.items.every(item => !executionIds.includes(item.id)), 'Revoked chat remains visible in console plans');
    assert.equal((await message('denied-revoked', '计划进度')).status, 403);
    await receipt(revoked.first);
    await noSuccessor(revoked.execution, 'revoked');
    await restartAndConnect(true);
    await noSuccessor(revoked.execution, 'revoked');
    assert.equal((await store.getExecution(revoked.execution.id)).status, 'failed');
    console.log('PASS allowlist revocation stops persistent plan; restart and late completion cannot resurrect it');
    assertHealthy();
    return { completed: chain.execution.id, cancelled: cancelled.execution.id, failed: revoked.execution.id };
  } finally {
    try {
      if (consoleProbe) await consoleProbe.close();
    } finally {
      await disconnect();
      // Preserve fixture evidence until its temporary database is removed by the caller.
      for (const id of executionIds) {
        const execution = await store.getExecution(id);
        if (execution?.status === 'active') {
          await store.compareAndSetExecution({ ...execution, revision: execution.revision + 1, status: 'cancelled' }, execution.revision);
        }
      }
    }
  }
}
