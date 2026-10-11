import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyNodeIsolation } from './test-node-isolation.mjs';
import { verifyDesktopRoute } from './test-desktop-route.mjs';
import { verifyPlanStore } from './test-plan-store.mjs';
import { verifyPlanConfirmationStore } from './test-plan-confirmation-store.mjs';
import { verifyNotificationStore } from './test-notification-store.mjs';
import { verifyPlanNotifications } from './test-plan-notifications.mjs';
import { verifyPlanExecution, planModelCall, PLAN_CHAT, PLAN_NODE } from './test-plan-execution.mjs';
import { closeTestWebSocket, withTestCleanup } from './scripts/test-cleanup.mjs';

const { values } = parseArgs({ options: {
  help: { type: 'boolean', short: 'h' },
  live: { type: 'boolean' },
  session: { type: 'string' },
} });
if (values.help) {
  console.log('Usage: node test-integration.mjs [--live [--session ID]]\nRequires built Controller and Gateway, Docker, Go, and postgres:16-alpine. Creates and cleans its own temporary database/container. Default: fixture nodes plus a real Go daemon connected ONLY to simulated desktop sockets; notification delivery uses simulated WeChat only. --live: built daemon/bin/super-leader-daemon and real Codex discovery/read ONLY. Never contacts WeChat or sends real prompts.');
} else {
  await main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

async function main() {
  const require = createRequire(new URL('./controller/package.json', import.meta.url));
  const { WebSocket } = require('ws');
  const password = randomBytes(24).toString('hex');
  const token = randomBytes(24).toString('hex');
  const nodeToken = randomBytes(24).toString('hex');
  const isolationTokens = Object.fromEntries(['scope-node-a', 'scope-node-b'].map(id => [id, randomBytes(24).toString('hex')]));
  const desktopToken = randomBytes(24).toString('hex');
  const planToken = randomBytes(24).toString('hex');
  const name = `super-leader-test-${randomUUID()}`;
  const docker = (args) => execFileSync('docker', args, {
    encoding: 'utf8', env: { ...process.env, POSTGRES_PASSWORD: password }, timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  let containerCreated = false;
  let controller;
  let daemon;
  let daemonStateDir;
  let socket;
  let modelServer;
  const logs = [];
  const fixtureSkill = { id: 'a'.repeat(64), digest: 'b'.repeat(64), name: 'integration-skill', description: 'Test fixture only', path: '/test/SKILL.md' };
  const skillRefs = [{ id: fixtureSkill.id, digest: fixtureSkill.digest }];
  const received = [];
  const inspections = [];
  await withTestCleanup(async () => {
    docker(['run', '--detach', '--rm', '--name', name, '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_USER=leader', '-e', 'POSTGRES_DB=leader', '-p', '127.0.0.1::5432', 'postgres:16-alpine']);
    containerCreated = true;
    const dbPort = docker(['port', name, '5432/tcp']).split(':').at(-1);
    await waitFor(async () => {
      try { docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'leader', '-d', 'leader']); return true; }
      catch (error) { if (error.status === 1 || error.status === 2) return false; throw error; }
    }, 'PostgreSQL readiness');
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
    const base = `http://127.0.0.1:${port}`;
    let modelPort;
    if (!values.live) {
      modelServer = createHttpServer(async (req, res) => {
        try {
          let body = '';
          for await (const chunk of req) body += chunk;
          const request = JSON.parse(body);
          const last = request.input.at(-1);
          let message = { role: 'assistant', content: 'Mock model response' };
          const call = (name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id: `mock-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
          const planCall = planModelCall(last.content);
          if (last.type === 'function_call_output') message.content = `Tool evidence: ${last.output}`;
          else if (planCall) message = call(planCall.name, planCall.args);
          else if (last.content === '请记住测试偏好') message = call('remember', { key: 'test-preference', value: '中文' });
          else if (last.content === '查询已记住的偏好') message = call('recall', {});
          else if (last.content === '查询桌面模型') message = call('list_sessions', { nodeId: 'desktop-fixture-node' });
          else if (last.content === '请给测试会话制定计划') message = call('propose_plan', { actions: [{ nodeId: 'test-node', sessionId: 'test-session', prompt: 'mock-plan-input', skills: skillRefs }] });
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
      modelPort = modelServer.address().port;
    }
    const env = {
      ...process.env, HOST: '127.0.0.1', PORT: String(port), PERSISTENCE_MODE: 'postgres',
      DATABASE_URL: `postgresql://leader:${password}@127.0.0.1:${dbPort}/leader`,
      CONTROLLER_TOKEN: token, NODE_TOKENS: JSON.stringify({ [values.live ? 'macair' : 'test-node']: nodeToken, ...(!values.live ? { ...isolationTokens, 'desktop-fixture-node': desktopToken, [PLAN_NODE]: planToken } : {}) }),
      CONSOLE_PUBLIC_URL: base,
      ALLOWED_CHAT_IDS: 'test-chat,' + PLAN_CHAT,
      LEADER_MODE: values.live ? 'rules' : 'model',
      LEADER_MODEL_BASE_URL: values.live ? '' : `http://127.0.0.1:${modelPort}/v1`,
      LEADER_MODEL_NAME: values.live ? '' : 'local-fixture-only',
      LEADER_MODEL_API_KEY: values.live ? '' : 'non-secret-test-key',
    };
    const start = async () => {
      controller = spawn(process.execPath, ['dist/index.js'], {
        cwd: fileURLToPath(new URL('./controller/', import.meta.url)), env, stdio: ['ignore', 'pipe', 'pipe'],
      });
      for (const stream of [controller.stdout, controller.stderr]) stream.on('data', chunk => {
        logs.push(chunk.toString().replaceAll(password, '[redacted]').replaceAll(token, '[redacted]').replaceAll(nodeToken, '[redacted]'));
        if (logs.length > 50) logs.shift();
      });
      await waitFor(async () => {
        if (controller.exitCode !== null) throw new Error(`Controller exited: ${logs.join('')}`);
        try { return (await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })).ok; }
        catch (error) { if (error instanceof TypeError || error.name === 'TimeoutError') return false; throw error; }
      }, 'Controller readiness');
    };
    const request = async (path, body, authenticated = true) => {
      const response = await fetch(`${base}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000),
      });
      return { status: response.status, body: await response.json() };
    };
    const { PostgresStore } = await import('./controller/dist/store/postgres.js');
    const stores = [new PostgresStore(env.DATABASE_URL), new PostgresStore(env.DATABASE_URL)];
    const { Pool } = require('pg');
    const fixturePool = new Pool({ connectionString: env.DATABASE_URL });
    await withTestCleanup(async () => {
      await stores[0].init();
      await verifyPlanStore({ stores, reopenStore: () => new PostgresStore(env.DATABASE_URL) });
      await verifyPlanConfirmationStore({ stores, pool: fixturePool, waitFor });
      await verifyNotificationStore({ stores, pool: fixturePool, reopenStore: () => new PostgresStore(env.DATABASE_URL) });
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
    if (values.live) {
      daemonStateDir = await mkdtemp(join(tmpdir(), 'super-leader-daemon-test-'));
      daemon = spawn(fileURLToPath(new URL('./daemon/bin/super-leader-daemon', import.meta.url)), [], {
        env: { ...process.env, NODE_ID: 'macair', NODE_TOKEN: nodeToken, CONTROLLER_WS_URL: `ws://127.0.0.1:${port}/v1/daemon`, DAEMON_STATE_DIR: daemonStateDir },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      for (const stream of [daemon.stdout, daemon.stderr]) stream.on('data', chunk => {
        logs.push(chunk.toString().replaceAll(nodeToken, '[redacted]'));
        if (logs.length > 50) logs.shift();
      });
      await waitFor(async () => {
        if (daemon.exitCode !== null) throw new Error(`Daemon exited: ${logs.join('')}`);
        return (await request('/v1/status')).body.sessions.some(session => session.nodeId === 'macair');
      }, 'Live Mac Air registration');
      const args = [fileURLToPath(new URL('./check-control-plane.mjs', import.meta.url)), '--url', base, '--node', 'macair'];
      if (values.session) args.push('--session', values.session);
      const checker = spawn(process.execPath, args, { env: { ...process.env, CONTROLLER_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
      checker.stdout.pipe(process.stdout);
      checker.stderr.pipe(process.stderr);
      const [exitCode] = await once(checker, 'exit');
      assert.equal(exitCode, 0, 'Live readonly smoke failed');
      console.log('PASS live Go Daemon → PostgreSQL-backed Controller → existing Codex session (readonly)');
      return;
    }
    assert([401, 403].includes((await request('/v1/status', undefined, false)).status));
    await verifyNodeIsolation({ WebSocket, base, request, nodeTokens: isolationTokens, waitFor });
    const desktopReceipt = await verifyDesktopRoute({ base, request, nodeToken: desktopToken, waitFor });
    const denied = await request('/v1/messages', { chatId: 'not-allowed', messageId: 'deny', text: '列出会话' });
    assert([401, 403].includes(denied.status), 'Chat allowlist must reject unauthorized senders');
    let deliveries = 0;
    const connectFake = async () => {
      socket = new WebSocket(`ws://127.0.0.1:${port}/v1/daemon`, { headers: { authorization: `Bearer ${nodeToken}` } });
      await once(socket, 'open');
      socket.on('message', raw => {
      const command = JSON.parse(raw.toString());
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
      socket.send(JSON.stringify({ type: 'hello', version: 1, nodeId: 'test-node', sessions: [{
      id: 'test-session', provider: 'codex-app', title: 'integration', cwd: '/test', status: 'idle', loaded: true, capabilities: ['read', 'send'], observedAt: new Date().toISOString(),
      }], skills: [fixtureSkill] }));
      await waitFor(async () => (await request('/v1/status')).body.sessions.length === 1, 'Daemon registration');
    };
    await connectFake();
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
    const pending = await request('/v1/commands', { ...payload, action: 'send', prompt: 'leave-pending', requestId: randomUUID() });
    await waitFor(async () => deliveries === 4, 'Pending dispatch');
    await closeTestWebSocket(socket);
    socket = undefined;
    await waitFor(async () => (await request(`/v1/commands/${pending.body.commandId}`)).body.status === 'uncertain', 'Disconnect uncertainty');
    await stop(controller);
    controller = undefined;
    await start();
    assert.deepEqual((await request(`/v1/commands/${desktopReceipt.commandId}`)).body, desktopReceipt,
      'Controller restart lost desktop route or exact native receipt');
    assert.equal((await request(`/v1/commands/${id}`)).body.status, 'completed');
    assert.equal((await request('/v1/commands', payload)).body.commandId, id, 'Restart lost idempotency');
    await connectFake();
    await waitFor(async () => (await request(`/v1/commands/${send.body.commandId}`)).body.status === 'completed', 'Exact turn reconciliation after restart');
    const tracked = (await request(`/v1/commands/${send.body.commandId}`)).body;
    assert.equal(tracked.turnId, `turn-${send.body.commandId}`);
    assert.equal(tracked.output, 'exact tracked turn final');
    assert.equal(tracked.error, undefined);
    assert.equal(deliveries, 4, 'Reconciliation replayed a send');
    assert(inspections.some(query => query.commandId === send.body.commandId && query.turnId === tracked.turnId));
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
    assert.equal((await message('confirm-fixture', '确认执行')).body.commandId, confirmation.body.commandId);
    assert.equal(deliveries, 5, 'Repeated confirmation dispatched twice');
    assert.equal((await message('confirm-fixture', '换一个任务')).status, 409);
    const recalled = await message('recall-fixture', '查询已记住的偏好');
    assert.equal(recalled.status, 200, JSON.stringify(recalled.body));
    assert(recalled.body.text.includes('中文'), 'Restart lost Leader memory');
    await stop(controller); controller = undefined;
    socket = undefined;
    await start();
    assert.deepEqual((await request(`/v1/commands/${confirmation.body.commandId}`)).body.skills, skillRefs, 'Restart lost persisted skill refs');
    console.log('PASS version-bound skill plan, authenticated catalog, wire refs, persisted skill refs after restart, conflicting idempotency key rejected');
    console.log('PASS model HTTP tools → persistent pending plan → restart → explicit confirmation; duplicate confirmation; chat memory persistence');
    console.log('PASS PostgreSQL persistence; HTTP auth; chat allowlist; WS registration; concurrent command dedupe; accepted != completed; disconnect uncertainty; Controller restart');
    console.log('PASS persisted turnId → Controller restart → readonly inspect → exact terminal output; no duplicate send; late acceptance ignored');
    const planStore = new PostgresStore(env.DATABASE_URL);
    await withTestCleanup(async () => {
      const restart = async (allowed = true) => {
          await stop(controller);
          controller = undefined;
          env.ALLOWED_CHAT_IDS = allowed ? 'test-chat,' + PLAN_CHAT : 'test-chat';
          await start();
      };
      const planIds = await verifyPlanExecution({ WebSocket, base, request, nodeToken: planToken, store: planStore, waitFor, restart });
      await verifyPlanNotifications({ base, token, request, store: planStore, restart, planIds });
    }, [{ label: 'plan PostgreSQL store', cleanup: () => planStore.close() }]);
  }, [
    { label: 'fixture WebSocket', cleanup: () => closeTestWebSocket(socket) },
    { label: 'fixture daemon', cleanup: () => daemon && stop(daemon) },
    { label: 'fixture daemon directory', cleanup: () => daemonStateDir && rm(daemonStateDir, { recursive: true, force: true }) },
    { label: 'fixture Controller', cleanup: () => controller && stop(controller) },
    { label: 'fixture model server', cleanup: () => modelServer && new Promise((resolve, reject) => modelServer.close(error => error ? reject(error) : resolve())) },
    { label: 'fixture PostgreSQL container', cleanup: () => containerCreated && docker(['stop', '--time', '5', name]) },
  ]);
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 25_000;
  do { if (await predicate()) return; await delay(100); } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
}
