import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer as createHttpServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { verifyNodeIsolation } from './sessions/node-isolation.mjs';
import { verifyNodeSessionStore } from './sessions/node-session-store.mjs';
import { verifyDesktopRoute } from './sessions/desktop-route.mjs';
import { createLeaderHistoryModelFixture, verifyLeaderSessionHistory } from './sessions/leader-session-history.mjs';
import { verifyTerminalObservation, terminalModelCall, TERMINAL_NODE } from './terminal/terminal-observation.mjs';
import { verifyTerminalControl, terminalInputModelCall, TERMINAL_INPUT_NODE } from './terminal/terminal-control.mjs';
import { verifyTerminalStore } from './terminal/terminal-store.mjs';
import { verifyTerminalHistory, TERMINAL_HISTORY_NODE } from './terminal/terminal-history.mjs';
import { verifyPlanStore } from './leader/plan-store.mjs';
import { verifyPlanConfirmationStore } from './leader/plan-confirmation-store.mjs';
import { verifyNotificationStore } from './leader/notification-store.mjs';
import { verifyNotificationMigration } from './leader/notification-migration.mjs';
import { verifyGoalNotifications } from './leader/goal-notifications.mjs';
import { verifyGoalNotificationStore } from './leader/goal-notification-store.mjs';
import { verifyPlanNotifications } from './leader/plan-notifications.mjs';
import { verifyPlanExecution, planModelCall, PLAN_CHAT, PLAN_NODE } from './leader/plan-execution.mjs';
import { verifyPlanResultHandoff, resultModelCall, RESULT_NODES } from './leader/plan-result-handoff.mjs';
import { verifyGoalStore } from './leader/goal-store.mjs';
import { verifyGoals, goalModelCall, GOAL_NODE, GOAL_CHAT } from './leader/goals.mjs';
import { closeTestWebSocket, withTestCleanup } from '../support/cleanup.mjs';
import { createControllerFixture, createPostgresFixture, waitFor } from '../support/control-plane-fixture.mjs';

const { values } = parseArgs({ options: {
  help: { type: 'boolean', short: 'h' },
} });
if (values.help) {
  console.log('Usage: node tests/integration/run.mjs\nRequires built Controller and Gateway, Docker, Go, and postgres:16-alpine. Creates and cleans its own temporary database/container. Uses fixture nodes plus a real Go daemon connected ONLY to simulated desktop sockets; notification delivery uses simulated WeChat only. Real Codex discovery/read is a separate opt-in entrypoint: tests/live/control-plane.mjs.');
} else {
  await main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

async function main() {
  const require = createRequire(new URL('../../controller/package.json', import.meta.url));
  const { WebSocket } = require('ws');
  const postgres = createPostgresFixture();
  const token = randomBytes(24).toString('hex');
  const nodeToken = randomBytes(24).toString('hex');
  const isolationTokens = Object.fromEntries(['scope-node-a', 'scope-node-b'].map(id => [id, randomBytes(24).toString('hex')]));
  const desktopToken = randomBytes(24).toString('hex');
  const terminalToken = randomBytes(24).toString('hex');
  const terminalInputToken = randomBytes(24).toString('hex');
  const terminalHistoryToken = randomBytes(24).toString('hex');
  const planToken = randomBytes(24).toString('hex');
  const goalToken = randomBytes(24).toString('hex');
  const resultTokens = Object.fromEntries(RESULT_NODES.map(id => [id, randomBytes(24).toString('hex')]));
  let controller;
  let socket;
  let modelServer;
  const logs = [];
  const fixtureSkills = Array.from({ length: 4 }, (_, index) => ({
    id: String(index + 1).repeat(64), digest: String(index + 5).repeat(64),
    name: '"'.repeat(126) + index, description: 'Test fixture only', path: `/test/${index}/SKILL.md`,
  }));
  const skillRefs = fixtureSkills.map(({ id, digest }) => ({ id, digest })).reverse();
  const received = [];
  const inspections = [];
  const leaderHistoryModel = createLeaderHistoryModelFixture({ nodeId: 'desktop-fixture-node',
    sessionId: '11111111-2222-4333-8444-555555555555' });
  await withTestCleanup(async () => {
    const databaseUrl = await postgres.start();
    modelServer = createHttpServer(async (req, res) => {
      try {
        let body = '';
        for await (const chunk of req) body += chunk;
        const request = JSON.parse(body);
        const last = request.input.at(-1);
        let message = { role: 'assistant', content: 'Mock model response' };
        const call = (name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id: `mock-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
        const planCall = planModelCall(last.content);
        const resultCall = resultModelCall(last.content);
        const terminalCall = terminalModelCall(last.content);
        const terminalInputCall = terminalInputModelCall(last.content);
        const goalCall = goalModelCall(last, request.tools);
        const historyReply = leaderHistoryModel.respond(last);
        if (goalCall) message = call(goalCall.name, goalCall.args);
        else if (historyReply) message = historyReply;
        else if (last.type === 'function_call_output') message.content = `Tool evidence: ${last.output}`;
        else if (planCall) message = call(planCall.name, planCall.args);
        else if (resultCall) message = call(resultCall.name, resultCall.args);
        else if (terminalCall) message = call(terminalCall.name, terminalCall.args);
        else if (terminalInputCall) message = call(terminalInputCall.name, terminalInputCall.args);
        else if (last.content === '请记住测试偏好') message = call('remember', { key: 'test-preference', value: '中文' });
        else if (last.content === '查询已记住的偏好') message = call('recall', {});
        else if (last.content === '查询桌面模型') message = call('list_sessions', { nodeId: 'desktop-fixture-node' });
        else if (last.content === '请给测试会话制定计划') message = call('propose_plan', { actions: [{ nodeId: 'test-node', sessionId: 'test-session', prompt: 'mock-plan-input', skills: skillRefs }] });
        else if (last.content === '请制定超长组合计划') message = call('propose_plan', { actions: fixtureSkills.map((_, index) => ({
          nodeId: 'test-node', sessionId: 'test-session', prompt: '任务'.repeat(500),
          skills: skillRefs, dependsOn: index ? [index] : [],
        })) });
        res.writeHead(200, { 'content-type': 'application/json' });
        const output = message.tool_calls
          ? message.tool_calls.map(call => ({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments }))
          : [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: message.content }] }];
        res.end(JSON.stringify({ status: 'completed', output }));
      } catch (error) {
        res.writeHead(500); res.end('Mock model fixture error');
        logs.push(`Mock model fixture failed: ${error.name}`);
      }
    });
    modelServer.listen(0, '127.0.0.1');
    await once(modelServer, 'listening');
    const nodeTokens = { 'test-node': nodeToken, ...isolationTokens, ...resultTokens, 'desktop-fixture-node': desktopToken,
      [TERMINAL_NODE]: terminalToken, [TERMINAL_INPUT_NODE]: terminalInputToken, [TERMINAL_HISTORY_NODE]: terminalHistoryToken,
      [PLAN_NODE]: planToken, [GOAL_NODE]: goalToken };
    controller = await createControllerFixture({ logs, secrets: [postgres.password, token, ...Object.values(nodeTokens)], env: {
      PERSISTENCE_MODE: 'postgres', DATABASE_URL: databaseUrl,
      CONTROLLER_TOKEN: token, NODE_TOKENS: JSON.stringify(nodeTokens),
      ALLOWED_CHAT_IDS: ['test-chat', PLAN_CHAT, GOAL_CHAT].join(','),
      LEADER_MODE: 'model', LEADER_MODEL_BASE_URL: `http://127.0.0.1:${modelServer.address().port}/v1`,
      LEADER_MODEL_NAME: 'local-fixture-only', LEADER_MODEL_API_KEY: 'non-secret-test-key',
    } });
    const { base, port, env, request } = controller;
    const start = () => controller.start();
    const { PostgresStore } = await import('../../controller/dist/store/postgres.js');
    const stores = [new PostgresStore(env.DATABASE_URL), new PostgresStore(env.DATABASE_URL)];
    const { Pool } = require('pg');
    const fixturePool = new Pool({ connectionString: env.DATABASE_URL });
    await withTestCleanup(async () => {
      await verifyNotificationMigration({ databaseUrl: env.DATABASE_URL, Pool, PostgresStore, pool: fixturePool });
      await stores[0].init();
      await verifyNodeSessionStore({ stores, pool: fixturePool, waitFor });
      await verifyTerminalStore({ stores });
      await verifyPlanStore({ stores, reopenStore: () => new PostgresStore(env.DATABASE_URL) });
      await verifyPlanConfirmationStore({ stores, pool: fixturePool, waitFor });
      await verifyNotificationStore({ stores, pool: fixturePool, reopenStore: () => new PostgresStore(env.DATABASE_URL) });
      await verifyGoalStore({ stores, pool: fixturePool, reopenStore: () => new PostgresStore(env.DATABASE_URL), waitFor });
      await verifyGoalNotificationStore({ stores, pool: fixturePool, reopenStore: () => new PostgresStore(env.DATABASE_URL) });
      await start();
      const creates = await Promise.all(stores.map((store, index) => store.compareAndSetLeaderState('cas-fixture', 0, { index })));
      assert.equal(creates.filter(Boolean).length, 1, 'Concurrent state creation must have one winner');
      const updates = await Promise.all(stores.map((store, index) => store.compareAndSetLeaderState('cas-fixture', 1, { updated: index })));
      assert.equal(updates.filter(Boolean).length, 1, 'Concurrent state update must have one winner');
      assert.equal((await stores[0].getLeaderState('cas-fixture')).revision, 2);
      assert.equal(await stores[1].compareAndSetLeaderState('missing-cas-fixture', 5, {}), null);
      console.log('PASS real PostgreSQL two-client state CAS: single create/update winner; missing revision rejected');
      const stamp = new Date().toISOString();
      await stores[0].createCommandIfAbsent({ commandId: 'turn-fixture', requestId: 'turn-fixture', nodeId: 'fixture-node',
        sessionId: 'fixture-session', action: 'send', prompt: 'fixture', status: 'pending', createdAt: stamp, updatedAt: stamp,
        expiresAt: new Date(Date.now() - 1000).toISOString() });
      const unbound = await stores[0].getCommand('turn-fixture');
      const invalidTurnIds = [undefined, '', ' ', 'turn id', 'turn\u0000id', 'turn\u0085id', 'turn\u00a0id', 'x'.repeat(129), '界'.repeat(43), '\ud800'];
      for (const status of ['accepted', 'completed']) {
        for (const turnId of invalidTurnIds) {
          await assert.rejects(stores[1].updateCommandStatus('turn-fixture', status, 'invalid receipt', undefined, turnId));
          assert.deepEqual(await stores[0].getCommand('turn-fixture'), unbound, 'Invalid receipt mutated persisted command');
        }
      }
      await assert.rejects(stores[1].updateCommandStatus('turn-fixture', 'completed', '', undefined, 'unaccepted-turn'));
      assert.deepEqual(await stores[0].getCommand('turn-fixture'), unbound, 'Completion bound a turn without acceptance');
      const bindings = await Promise.allSettled(stores.map((store, index) => store.updateCommandStatus('turn-fixture', 'accepted', '', undefined, `turn-${index}`)));
      assert.equal(bindings.filter(item => item.status === 'fulfilled').length, 1, 'Concurrent turn binding must have one winner');
      const bound = await stores[0].getCommand('turn-fixture');
      await assert.rejects(stores[1].updateCommandStatus('turn-fixture', 'completed', 'unbound completion'));
      assert.deepEqual(await stores[0].getCommand('turn-fixture'), bound, 'Missing turn ID changed bound command');
      await stores[0].markExpiredActiveCommandsUncertain();
      assert.equal((await stores[0].getCommand('turn-fixture')).status, 'accepted', 'Dispatch TTL terminated a tracked turn');
      assert.equal((await stores[0].listInspectableCommands('fixture-node', 1))[0].turnId, bound.turnId);
      await stores[0].markNodeActiveCommandsUncertain('fixture-node', 'disconnect');
      await stores[1].updateCommandStatus('turn-fixture', 'completed', 'exact final', undefined, bound.turnId);
      const terminal = await stores[0].getCommand('turn-fixture');
      assert.equal(terminal.error, undefined, 'Recovered terminal retained stale disconnect error');
      await stores[1].updateCommandStatus('turn-fixture', 'accepted', 'late acceptance', 'late error', bound.turnId);
      await stores[1].updateCommandStatus('turn-fixture', 'failed', 'wrong terminal', 'late failure', bound.turnId);
      assert.deepEqual(await stores[0].getCommand('turn-fixture'), terminal, 'Late result changed terminal record');
      console.log('PASS real PostgreSQL rejects missing/malformed/unaccepted turn IDs; failed transactions preserve exact command');
      console.log('PASS real PostgreSQL turn-binding race, tracked TTL exemption, error recovery and immutable terminal record');
      for (const sendRoute of ['desktop-owner', 'control-socket']) {
        const record = { commandId: `route-${sendRoute}`, requestId: `route-${sendRoute}`, nodeId: 'fixture-node',
          sessionId: 'fixture-session', action: 'send', prompt: 'fixture', sendRoute, status: 'pending',
          createdAt: stamp, updatedAt: stamp, expiresAt: new Date(Date.now() + 60_000).toISOString() };
        await stores[0].createCommandIfAbsent(record);
        assert.equal((await stores[1].getCommand(record.commandId)).sendRoute, sendRoute);
        assert.equal((await stores[1].findCommandByRequestId(record.requestId)).sendRoute, sendRoute);
        const reused = await stores[1].createCommandIfAbsent({ ...record, commandId: randomUUID(),
          sendRoute: sendRoute === 'desktop-owner' ? 'control-socket' : 'desktop-owner' });
        assert.equal(reused.command.sendRoute, sendRoute, 'Dedup reselected the persisted route');
      }
      assert.equal(terminal.sendRoute, undefined, 'Existing unbound route was backfilled');
      console.log('PASS real PostgreSQL fixed send-route roundtrip, cross-client dedup, legacy null route preserved');
    }, [
      { label: 'fixture PostgreSQL pool', cleanup: () => fixturePool.end() },
      ...stores.map((store, index) => ({ label: `fixture PostgreSQL store ${index}`, cleanup: () => store.close() })),
    ]);
    assert([401, 403].includes((await request('/v1/status', undefined, false)).status));
    await verifyNodeIsolation({ WebSocket, base, request, nodeTokens: isolationTokens, waitFor });
    await verifyTerminalObservation({ base, request, nodeToken: terminalToken, waitFor });
    await verifyTerminalHistory({ base, request, nodeToken: terminalHistoryToken, waitFor });
    const terminalInputReceipt = await verifyTerminalControl({ base, request, nodeToken: terminalInputToken, waitFor,
      openStore: () => new PostgresStore(env.DATABASE_URL),
      restart: async () => { await controller.stop(); await start(); } });
    let desktopSkillReceipt;
    let desktopReceipt, leaderHistoryVerified = false;
    const desktopHistoryPool = new Pool({ connectionString: env.DATABASE_URL });
    await withTestCleanup(async () => {
      desktopReceipt = await verifyDesktopRoute({ base, request, nodeToken: desktopToken, waitFor,
        onSkillReceipt: receipt => { desktopSkillReceipt = receipt; },
        onHistoryReady: async fixture => {
          await verifyLeaderSessionHistory({ request, pool: desktopHistoryPool, model: leaderHistoryModel, ...fixture });
          leaderHistoryVerified = true;
        } });
    }, [{ label: 'desktop history PostgreSQL pool', cleanup: () => desktopHistoryPool.end() }]);
    assert(leaderHistoryVerified, 'Leader history regression was not exercised');
    assert(desktopSkillReceipt, 'Missing real Go ordered skill receipt');
    const denied = await request('/v1/messages', { chatId: 'not-allowed', messageId: 'deny', text: '列出会话' });
    assert([401, 403].includes(denied.status), 'Chat allowlist must reject unauthorized senders');
    let deliveries = 0;
    const connectFake = async () => {
      socket = new WebSocket(`ws://127.0.0.1:${port}/v1/daemon`, { headers: { authorization: `Bearer ${nodeToken}` } });
      await once(socket, 'open');
      socket.on('message', raw => {
      const command = JSON.parse(raw.toString());
      if (command.type === 'inspect_command') {
        inspections.push(command);
        socket.send(JSON.stringify({ type: 'result', commandId: command.commandId,
          status: 'uncertain', error: 'Synthetic journal has no immutable terminal receipt' }));
        return;
      }
      if (command.type === 'inspect_turn') {
        inspections.push(command);
        socket.send(JSON.stringify({ type: 'result', commandId: command.commandId, turnId: command.turnId,
          status: 'completed', output: 'exact tracked turn final' }));
        return;
      }
      if (command.type !== 'command') return;
      deliveries++;
      received.push(command);
      if (command.prompt === 'leave-pending') return;
      socket.send(JSON.stringify({ type: 'result', commandId: command.commandId, status: command.action === 'send' ? 'accepted' : 'completed',
        ...(command.action === 'send' ? { turnId: `turn-${command.commandId}` } : {}), output: 'integration-result' }));
      });
      const sessions = () => ['test-session', 'pending-session'].map(id => ({
      id, provider: 'codex-app', title: 'integration', cwd: '/test', status: 'idle', loaded: true, capabilities: ['read', 'send'], observedAt: new Date().toISOString(),
      }));
      socket.send(JSON.stringify({ type: 'hello', version: 1, nodeId: 'test-node', sessions: sessions(), skills: fixtureSkills }));
      await waitFor(async () => (await request('/v1/status')).body.sessions.length === 2, 'Daemon registration');
      return () => socket.send(JSON.stringify({type:'heartbeat',sessions:sessions(),skills:fixtureSkills}));
    };
    await connectFake();
    const oversized = await request('/v1/messages', {
      chatId: 'test-chat', messageId: 'oversized-skill-preview', text: '请制定超长组合计划',
    });
    assert.equal(oversized.status, 200, JSON.stringify(oversized.body));
    assert(oversized.body.text.includes('无法完整展示供确认'), 'Oversized skill preview was silently clipped');
    const oversizedConfirm = await request('/v1/messages', {
      chatId: 'test-chat', messageId: 'oversized-skill-confirm', text: '确认执行',
    });
    assert.equal(oversizedConfirm.status, 200, JSON.stringify(oversizedConfirm.body));
    assert(oversizedConfirm.body.text.includes('没有待确认计划'));
    assert.equal(deliveries, 0, 'Clipped plan authorized unseen steps');
    console.log('PASS model HTTP → oversized four-step skill preview refused; explicit confirmation has no pending plan and no dispatch');
    assert([401, 403].includes((await request('/v1/skills', undefined, false)).status));
    const payload = { nodeId: 'test-node', sessionId: 'test-session', action: 'read', requestId: randomUUID() };
    const command = await request('/v1/commands', payload);
    assert([200, 201, 202].includes(command.status), JSON.stringify(command.body));
    const id = command.body.commandId;
    assert(id);
    await waitFor(async () => (await request(`/v1/commands/${id}`)).body.status === 'completed', 'Read completion');
    const duplicates = await Promise.all(Array.from({ length: 8 }, () => request('/v1/commands', payload)));
    for (const duplicate of duplicates) assert.equal(duplicate.body.commandId, id);
    assert.equal(deliveries, 1, 'Duplicate command was dispatched');
    const concurrentPayload = { ...payload, requestId: randomUUID() };
    const concurrent = await Promise.all(Array.from({ length: 8 }, () => request('/v1/commands', concurrentPayload)));
    const concurrentId = concurrent[0].body.commandId;
    assert(concurrentId, 'Concurrent creation returned no command ID');
    for (const result of concurrent) assert.equal(result.body.commandId, concurrentId, 'Concurrent request did not reuse command');
    await waitFor(async () => (await request(`/v1/commands/${concurrentId}`)).body.status === 'completed', 'Concurrent command completion');
    assert.equal(deliveries, 2, 'Concurrent creation dispatched duplicate commands');
    const conflict = await request('/v1/commands', { ...payload, action: 'send', prompt: 'different-payload' });
    assert.equal(conflict.status, 409, 'Reused key with different payload must be rejected');
    const send = await request('/v1/commands', { ...payload, action: 'send', prompt: 'test-only', requestId: randomUUID() });
    await waitFor(async () => (await request(`/v1/commands/${send.body.commandId}`)).body.status === 'accepted', 'Send acknowledgement');
    const message = (messageId, text) => request('/v1/messages', { chatId: 'test-chat', messageId, text });
    const memory = await message('remember-fixture', '请记住测试偏好');
    assert.equal(memory.status, 200, JSON.stringify(memory.body));
    assert(memory.body.text.includes('记忆更新'));
    const plan = await message('plan-fixture', '请给测试会话制定计划');
    assert.equal(plan.status, 200, JSON.stringify(plan.body));
    assert(plan.body.text.includes('尚未派发'));
    assert.equal(deliveries, 3, 'Model planning dispatched a write before human confirmation');
    // The accepted turn deliberately stays unfinished until restart inspection.
    // Exercise disconnect ambiguity on another exact target instead of bypassing its FIFO fence.
    const pending = await request('/v1/commands', { ...payload, sessionId: 'pending-session', action: 'send', prompt: 'leave-pending', requestId: randomUUID() });
    await waitFor(async () => deliveries === 4, 'Pending dispatch');
    assert.equal((await request(`/v1/commands/${send.body.commandId}`)).body.status, 'accepted');
    await closeTestWebSocket(socket);
    socket = undefined;
    await waitFor(async () => (await request(`/v1/commands/${pending.body.commandId}`)).body.status === 'uncertain', 'Disconnect uncertainty');
    await controller.stop();
    await start();
    assert.deepEqual((await request(`/v1/commands/${desktopReceipt.commandId}`)).body, desktopReceipt,
      'Controller restart lost desktop route or exact native receipt');
    assert.deepEqual((await request(`/v1/commands/${terminalInputReceipt.commandId}`)).body, terminalInputReceipt,
      'Controller restart lost terminal input proof or promoted it to native completion');
    assert.deepEqual((await request(`/v1/commands/${desktopSkillReceipt.commandId}`)).body, desktopSkillReceipt,
      'Controller restart lost ordered skill refs or exact desktop skill receipt');
    assert.equal((await request(`/v1/commands/${id}`)).body.status, 'completed');
    assert.equal((await request('/v1/commands', payload)).body.commandId, id, 'Restart lost idempotency');
    const heartbeat = await connectFake();
    await waitFor(async () => {
      heartbeat();
      return (await request(`/v1/commands/${send.body.commandId}`)).body.status === 'completed';
    }, 'Exact turn reconciliation after restart');
    const tracked = (await request(`/v1/commands/${send.body.commandId}`)).body;
    assert.equal(tracked.turnId, `turn-${send.body.commandId}`);
    assert.equal(tracked.output, 'exact tracked turn final');
    assert.equal(tracked.error, undefined);
    assert.equal(deliveries, 4, 'Reconciliation replayed a send');
    assert(inspections.some(query => query.commandId === send.body.commandId && query.turnId === tracked.turnId));
    await waitFor(async () => {
      heartbeat();
      return inspections.some(query => query.type === 'inspect_command' && query.commandId === pending.body.commandId);
    }, 'Unknown command journal inspection without replay');
    const unknownInspection = inspections.find(query => query.type === 'inspect_command' && query.commandId === pending.body.commandId);
    assert.equal(unknownInspection.sessionId, 'pending-session');
    assert.equal(unknownInspection.prompt, 'leave-pending');
    assert.equal((await request(`/v1/commands/${pending.body.commandId}`)).body.status, 'uncertain');
    assert.equal(deliveries, 4, 'Unknown journal inspection replayed a mutation');
    socket.send(JSON.stringify({ type: 'result', commandId: send.body.commandId, turnId: tracked.turnId, status: 'accepted', output: 'late acceptance' }));
    await delay(100);
    assert.deepEqual((await request(`/v1/commands/${send.body.commandId}`)).body, tracked);
    const confirmation = await message('confirm-fixture', '确认执行');
    assert.equal(confirmation.status, 200, JSON.stringify(confirmation.body));
    assert(confirmation.body.commandId, 'Restart lost pending model plan');
    assert.equal(deliveries, 5);
    assert.deepEqual(received.at(-1).skills, skillRefs, 'Confirmed plan lost skill version on wire');
    const persistedSkillCommand = (await request(`/v1/commands/${confirmation.body.commandId}`)).body;
    assert.deepEqual(persistedSkillCommand.skills, skillRefs, 'PostgreSQL command lost skill refs');
    const altered = await request('/v1/commands', { nodeId: persistedSkillCommand.nodeId,
      sessionId: persistedSkillCommand.sessionId, action: 'send', prompt: persistedSkillCommand.prompt,
      requestId: persistedSkillCommand.requestId, skills: [] });
    assert.equal(altered.status, 409, 'Request ID reused with different skills');
    const reordered = await request('/v1/commands', { nodeId: persistedSkillCommand.nodeId,
      sessionId: persistedSkillCommand.sessionId, action: 'send', prompt: persistedSkillCommand.prompt,
      requestId: persistedSkillCommand.requestId, skills: [...skillRefs].reverse() });
    assert.equal(reordered.status, 409, 'Request ID reused with a different skill order');
    assert.equal((await message('confirm-fixture', '确认执行')).body.commandId, confirmation.body.commandId);
    assert.equal(deliveries, 5, 'Repeated confirmation dispatched twice');
    assert.equal((await message('confirm-fixture', '换一个任务')).status, 409);
    const recalled = await message('recall-fixture', '查询已记住的偏好');
    assert.equal(recalled.status, 200, JSON.stringify(recalled.body));
    assert(recalled.body.text.includes('中文'), 'Restart lost Leader memory');
    await controller.stop();
    socket = undefined;
    await start();
    assert.deepEqual((await request(`/v1/commands/${confirmation.body.commandId}`)).body.skills, skillRefs, 'Restart lost persisted skill refs');
    console.log('PASS four ordered version-bound skills: model plan, confirmation, authenticated catalog, wire refs, PostgreSQL restart persistence, reordered idempotency payload rejected');
    console.log('PASS model HTTP tools → persistent pending plan → restart → explicit confirmation; duplicate confirmation; chat memory persistence');
    console.log('PASS PostgreSQL persistence; HTTP auth; chat allowlist; WS registration; concurrent command dedupe; accepted != completed; disconnect uncertainty; Controller restart');
    console.log('PASS persisted turnId → Controller restart → readonly inspect → exact terminal output; no duplicate send; late acceptance ignored');
    const planStore = new PostgresStore(env.DATABASE_URL);
    await withTestCleanup(async () => {
      const restart = async (allowed = true) => {
          await controller.stop();
          env.ALLOWED_CHAT_IDS = allowed ? ['test-chat', PLAN_CHAT, GOAL_CHAT].join(',') : 'test-chat';
          await start();
      };
      const planIds = await verifyPlanExecution({ WebSocket, base, request, nodeToken: planToken, store: planStore, waitFor, restart });
      await verifyPlanNotifications({ base, token, request, store: planStore, restart, planIds });
      await verifyPlanResultHandoff({ WebSocket, base, request, nodeTokens: resultTokens, store: planStore,
        reopenStore: () => new PostgresStore(env.DATABASE_URL), restart, waitFor });
      const goalIds = await verifyGoals({ WebSocket, base, request, nodeToken: goalToken, store: planStore, restart, waitFor });
      await verifyGoalNotifications({ base, token, request, store: planStore, restart, goalIds });
    }, [{ label: 'plan PostgreSQL store', cleanup: () => planStore.close() }]);
  }, [
    { label: 'fixture WebSocket', cleanup: () => closeTestWebSocket(socket) },
    { label: 'fixture Controller', cleanup: () => controller?.stop() },
    { label: 'fixture model server', cleanup: () => modelServer && new Promise((resolve, reject) => modelServer.close(error => error ? reject(error) : resolve())) },
    { label: 'fixture PostgreSQL container', cleanup: () => postgres.stop() },
  ]);
}
