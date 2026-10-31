import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { verificationEnvironment } from '../../../scripts/verify.mjs';
import { stopTestProcess, withTestCleanup } from '../../support/cleanup.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DEADLINE_MS = 15_000;
const PRIVATE = 'synthetic-private-token-account-message';
const { values } = parseArgs({ options: { run: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
if (!values.run || values.help) console.log('Usage: node tests/integration/leader/notification-diagnostics.mjs --run\nStarts the built Gateway CLI against isolated HTTP/HTTPS fixtures; no production or message sending.');
else await verify().catch(error => { console.error(error); process.exitCode = 1; });

async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; }
async function close(server) {
  if (!server?.listening) return;
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
function json(response, body) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); }

async function verify() {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-notification-diagnostics-'));
  const account = join(dir, 'account.json'), state = join(dir, 'state.json'), health = join(dir, 'health.json');
  const cert = join(dir, 'cert.pem'), key = join(dir, 'key.pem');
  let controller, wechat, child, deadline, requests = 0, sends = 0;
  let stderr = '', stdout = '', failure;
  const events = () => stderr.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))
    .filter(event => event.event?.startsWith('notification_cycle_'));
  await withTestCleanup(async () => {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-sha256',
      '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', cert],
    { timeout: DEADLINE_MS, stdio: ['ignore', 'pipe', 'pipe'] });
    controller = createServer((request, response) => {
      if (request.url !== '/v1/chats/notification-interest' || request.headers.authorization !== `Bearer ${PRIVATE}`) {
        failure = new Error('Unexpected fixture Controller request'); response.writeHead(500); response.end(); return;
      }
      if (++requests === 1) { response.destroy(); return; }
      if (requests === 2) {
        response.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' });
        response.write('{"chatIds":');
        setTimeout(() => response.destroy(), 30);
        return;
      }
      json(response, { chatIds: [], interested: [] });
    });
    wechat = createHttpsServer({ key: await readFile(key), cert: await readFile(cert) }, (request, response) => {
      if (request.url !== '/ilink/bot/getupdates') {
        sends++; failure = new Error('Fixture must never send WeChat messages'); response.writeHead(500); response.end(); return;
      }
      request.resume();
      setTimeout(() => json(response, { ret: 0, msgs: [], get_updates_buf: 'synthetic-cursor' }), 40);
    });
    const controllerPort = await listen(controller), wechatPort = await listen(wechat);
    await writeFile(account, JSON.stringify({ token: PRIVATE, accountId: PRIVATE, baseUrl: `https://127.0.0.1:${wechatPort}` }), { mode: 0o600 });
    await writeFile(state, JSON.stringify({ baseline_established: true, context_tokens: {} }), { mode: 0o600 });
    child = spawn(process.execPath, ['gateway/dist/index.js', '--run', '--leader-mode', 'controller',
      '--controller-url', `http://127.0.0.1:${controllerPort}`, '--credentials-path', account, '--state-path', state,
      '--health-path', health, '--poll-interval-ms', '100'], { cwd: ROOT,
      env: { ...verificationEnvironment(), CONTROLLER_TOKEN: PRIVATE, NODE_EXTRA_CA_CERTS: cert }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    deadline = setTimeout(() => { failure = new Error('Diagnostic CLI observation timed out'); child.kill('SIGTERM'); }, DEADLINE_MS);
    const started = Date.now();
    while (!events().some(event => event.event === 'notification_cycle_recovered')) {
      if (failure) throw failure;
      assert.equal(child.exitCode, null, stderr);
      assert.ok(Date.now() - started < DEADLINE_MS, stderr);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    // Observe more complete cycles: recovery must be a single transition, not a per-poll log.
    await new Promise(resolve => setTimeout(resolve, 400));
    await stopTestProcess(child);
    assert.equal(child.exitCode, 0, stderr + stdout);
    if (failure) throw failure;
    const captured = events();
    assert.deepEqual(captured.map(event => event.event), ['notification_cycle_failed', 'notification_cycle_failed', 'notification_cycle_recovered']);
    assert.deepEqual(captured.slice(0, 2).map(event => event.phase), ['fetch', 'body']);
    assert.ok(captured.slice(0, 2).every(event => event.operation === 'notification_interest' && event.stage === 'interest' &&
      event.causeCodes.includes('UND_ERR_SOCKET') && event.requestAttempts === 1 && event.retryScheduled));
    assert.equal(captured[1].httpStatus, 200);
    assert.deepEqual(captured[2].recoveredOperations, ['notification_interest']);
    assert.equal(requests, 3);
    assert.equal(sends, 0);
    assert.ok(!stderr.includes(PRIVATE));
    assert.ok(captured.every(event => !JSON.stringify(event).includes('127.0.0.1')));
    const data = JSON.parse(await readFile(health, 'utf8'));
    assert.equal(data.total_error_count, 0);
    assert.ok(data.last_poll_succeeded_at);
    assert.equal(data.status, 'stopped');
    for (const event of captured) console.log(JSON.stringify(event));
    console.log('PASS actual Gateway CLI: socket failure before headers and after HTTP200 body, retry then one full-cycle recovery; independent inbound health; zero WeChat sends');
  }, [
    { label: 'deadline', cleanup: async () => clearTimeout(deadline) },
    { label: 'Gateway CLI', cleanup: () => stopTestProcess(child) },
    { label: 'Controller fixture', cleanup: () => close(controller) },
    { label: 'iLink HTTPS fixture', cleanup: () => close(wechat) },
    { label: 'isolated files', cleanup: () => rm(dir, { recursive: true, force: true }) },
  ]);
}
