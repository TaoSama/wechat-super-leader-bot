import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { ControllerServer } from '../../controller/dist/http/server.js';
import { MemoryStore } from '../../controller/dist/store/memory.js';
import { createExecution } from '../../controller/dist/leader/plans/execution.js';
import { ControllerClient } from '../../gateway/dist/controller/client.js';
import { ResultClient } from '../../gateway/dist/controller/result-client.js';

const CHAT = 'synthetic-internal-transport-chat';
const PLAN_ID = '00000000-0000-4000-8000-000000000001';
const PORT = 8790;
const DEADLINE_MS = 10_000;
const { values } = parseArgs({ options: { mode: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
if (values.help) console.log('Usage: internal-controller-probe.mjs --mode serve|probe\nOnly for the isolated Docker transport fixture.');
else if (values.mode === 'serve') await serve();
else if (values.mode === 'probe') await probe();
else throw new Error('Expected --mode serve or probe');

async function serve() {
  const store = new MemoryStore(), now = Date.now();
  const execution = createExecution(CHAT, { id: PLAN_ID, expiresAt: now + DEADLINE_MS,
    actions: [{ nodeId: 'fixture', sessionId: 'session', prompt: 'synthetic transport result',
      dependsOn: [], sendRoute: 'control-socket' }] }, now);
  await store.createExecutionIfAbsent(execution);
  await store.compareAndSetExecution({ ...execution, revision: 2, status: 'completed' }, 1, now);
  const server = new ControllerServer({ host: '0.0.0.0', port: PORT, controllerToken: process.env.CONTROLLER_TOKEN,
    nodeTokens: {}, tokenToNode: new Map(), allowedChatIds: new Set([CHAT]), persistenceMode: 'memory',
    commandTtlSeconds: 60, consolePublicUrl: process.env.CONSOLE_PUBLIC_URL, settingsRoot: '/tmp/fixture-settings',
    taskNotifications: { tickMs: 100, fileMaxBytes: 1024 * 1024, retentionMs: 60_000 } }, store);
  try {
    await server.start();
    await new Promise(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve); });
  } finally { await server.stop(); }
}

async function probe() {
  const options = { controllerUrl: process.env.CONTROLLER_URL, controllerToken: process.env.CONTROLLER_TOKEN,
    allowInsecureController: process.env.ALLOW_INSECURE_CONTROLLER === 'true' };
  const results = new ResultClient({ ...options, artifactPublicOrigin: process.env.RESULT_PUBLIC_ORIGIN });
  const notifications = new ControllerClient(options);
  assert.deepEqual(await results.notificationInterest(), { chatIds: [CHAT], interested: [CHAT] });
  assert.ok(Array.isArray(await notifications.listNotifications([CHAT])));
  console.log('PASS authenticated notification-interest and notification list over http://controller:8790');

  for (const path of ['/v1/chats/notification-interest', '/v1/notifications/pending', '/v1/deliveries/pending']) {
    const body = path.endsWith('/pending') ? JSON.stringify({ chatIds: [CHAT] }) : undefined;
    const response = await fetch(options.controllerUrl + path, { method: body ? 'POST' : 'GET', body,
      headers: { Authorization: 'Bearer synthetic-wrong-token', 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(DEADLINE_MS) });
    assert.equal(response.status, 403);
    await response.arrayBuffer();
    const missing = await fetch(options.controllerUrl + path, { method: body ? 'POST' : 'GET', body,
      headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(DEADLINE_MS) });
    assert.equal(missing.status, 401); await missing.arrayBuffer();
  }
  console.log('PASS wrong bearer rejected on interest and both list endpoints');

  let plan;
  const deadline = Date.now() + DEADLINE_MS;
  do {
    plan = (await results.listDeliveries([CHAT])).find(item => item.source.id === PLAN_ID);
    if (!plan) await delay(100);
  } while (!plan && Date.now() < deadline);
  assert.ok(plan, 'Synthetic terminal result was not collected');
  const attempt = randomUUID();
  await results.claimDelivery(plan.id, attempt);
  const materialized = await results.materializeDelivery(plan.id, attempt);
  assert.equal(new URL(materialized.artifact.downloadUrl).origin, process.env.RESULT_PUBLIC_ORIGIN);
  assert.equal(new URL(materialized.artifact.downloadUrl).protocol, 'https:');
  const content = await results.downloadArtifact(materialized.artifact);
  assert.ok(content.toString().includes('synthetic transport result'));
  console.log('PASS signed public HTTPS URL retained; byte-checked artifact downloaded through internal Controller');

  const untrusted = new URL(materialized.artifact.downloadUrl); untrusted.hostname = 'untrusted.fixture.invalid';
  await assert.rejects(results.downloadArtifact({ ...materialized.artifact, downloadUrl: untrusted.href }), /Untrusted/);
  const tampered = new URL(materialized.artifact.downloadUrl); tampered.searchParams.set('signature', '0'.repeat(64));
  await assert.rejects(results.downloadArtifact({ ...materialized.artifact, downloadUrl: tampered.href }), /invalid response/);
  const invalidSignature = await fetch(options.controllerUrl + tampered.pathname + tampered.search,
    { signal: AbortSignal.timeout(DEADLINE_MS) });
  assert.equal(invalidSignature.status, 403); await invalidSignature.arrayBuffer();
  const receipt = `/v1/deliveries/${plan.id}/receipt`;
  const wrongReceipt = await fetch(options.controllerUrl + receipt, { method: 'POST',
    headers: { Authorization: 'Bearer synthetic-wrong-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ attemptId: attempt, status: 'accepted' }), signal: AbortSignal.timeout(DEADLINE_MS) });
  assert.equal(wrongReceipt.status, 403); await wrongReceipt.arrayBuffer();
  assert.equal((await results.recordReceipt(plan.id, attempt, 'accepted')).status, 'accepted');
  assert.deepEqual(await results.listDeliveries([CHAT]), []);
  console.log('PASS synthetic receipt persisted; wrong receipt token, untrusted origin and modified signature rejected');

  await writeFile('/tmp/fixture-account.json', JSON.stringify({ token: 'synthetic-wechat-token', accountId: 'fixture',
    baseUrl: 'https://wechat.fixture.invalid' }), { mode: 0o600 });
  const check = env => spawnSync(process.execPath, ['gateway/dist/index.js', '--check', '--leader-mode', 'controller',
    '--credentials-path', '/tmp/fixture-account.json', '--state-path', '/tmp/fixture-state.json'],
  { env: { ...process.env, ...env }, encoding: 'utf8', timeout: DEADLINE_MS });
  const good = check({}); assert.equal(good.status, 0, good.stderr);
  assert.equal(JSON.parse(good.stdout).controllerUrl, options.controllerUrl);
  const denied = check({ ALLOW_INSECURE_CONTROLLER: 'false' });
  assert.equal(denied.status, 1); assert.match(denied.stderr, /fatal: OperationalError/);
  assert.throws(() => new ControllerClient({ ...options, allowInsecureController: false }), /must use https/);
  const remote = check({ CONTROLLER_URL: 'https://remote.fixture.invalid', ALLOW_INSECURE_CONTROLLER: 'false' });
  assert.equal(remote.status, 0, remote.stderr);
  assert.equal(JSON.parse(remote.stdout).controllerUrl, 'https://remote.fixture.invalid');
  console.log('PASS actual Gateway CLI accepts explicit private HTTP, rejects missing opt-in and retains remote HTTPS support; check mode makes no WeChat requests');
}
