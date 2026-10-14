import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { stopTestProcess, withTestCleanup } from '../support/cleanup.mjs';
import { createControllerFixture, createPostgresFixture, waitFor } from '../support/control-plane-fixture.mjs';

const NODE_ID = 'macair';
const READ_TIMEOUT_MS = 45_000;
const READ_POLL_INTERVAL_MS = 250;
const LOG_LIMIT = 50;

const { values } = parseArgs({ options: {
  help: { type: 'boolean', short: 'h' },
  run: { type: 'boolean' },
  socket: { type: 'string' },
  session: { type: 'string' },
} });
if (values.help) {
  console.log('Usage: node tests/live/control-plane.mjs --run --socket /absolute/codex.sock [--session ID]\nRequires built Controller, daemon/bin/super-leader-daemon, Docker, and postgres:16-alpine. Explicit opt-in: starts a temporary PostgreSQL-backed Controller and daemon for real Codex discovery through the chosen existing socket; optionally reads the selected existing session and checks request deduplication. Cleans only resources it creates. Never contacts WeChat, sends prompts, or enables desktop-owner sending.');
} else if (!values.run) {
  console.error('Explicit --run required: this connects to the real Codex discovery socket.');
  process.exitCode = 1;
} else {
  await main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

async function main() {
  assert(values.socket, 'Missing required option: --socket /absolute/codex.sock');
  assert(isAbsolute(values.socket) && !/[\0\r\n]/u.test(values.socket), '--socket must be an absolute path without control characters');
  if (values.session !== undefined) assert(values.session.trim(), '--session must not be empty');
  const sessionId = values.session?.trim();
  const postgres = createPostgresFixture();
  const token = randomBytes(24).toString('hex');
  const nodeToken = randomBytes(24).toString('hex');
  const logs = [];
  let controller, daemon, daemonStateDir, daemonError;
  await withTestCleanup(async () => {
    const databaseUrl = await postgres.start();
    controller = await createControllerFixture({ logs, secrets: [postgres.password, token, nodeToken], env: {
      PERSISTENCE_MODE: 'postgres', DATABASE_URL: databaseUrl, CONTROLLER_TOKEN: token,
      NODE_TOKENS: JSON.stringify({ [NODE_ID]: nodeToken }), ALLOWED_CHAT_IDS: 'test-chat',
      LEADER_MODE: 'rules', LEADER_MODEL_BASE_URL: '', LEADER_MODEL_NAME: '', LEADER_MODEL_API_KEY: '',
    } });
    await controller.start();
    assert([401, 403].includes((await controller.request('/v1/status', undefined, false)).status),
      'Unauthenticated status access was not rejected');
    daemonStateDir = await mkdtemp(join(tmpdir(), 'super-leader-daemon-test-'));
    daemon = spawn(fileURLToPath(new URL('../../daemon/bin/super-leader-daemon', import.meta.url)), ['--sock', values.socket], {
      env: { ...process.env, NODE_ID, NODE_TOKEN: nodeToken,
        CONTROLLER_WS_URL: `ws://127.0.0.1:${controller.port}/v1/daemon`, DAEMON_STATE_DIR: daemonStateDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    daemon.on('error', error => { daemonError = error; });
    for (const stream of [daemon.stdout, daemon.stderr]) stream.on('data', chunk => {
      logs.push(chunk.toString().replaceAll(nodeToken, '[redacted]'));
      if (logs.length > LOG_LIMIT) logs.shift();
    });
    let sessions;
    await waitFor(async () => {
      if (daemonError) throw daemonError;
      if (daemon.exitCode !== null || daemon.signalCode !== null) throw new Error(`Daemon exited: ${logs.join('')}`);
      const snapshot = await controller.request('/v1/status');
      assert.equal(snapshot.status, 200);
      assert(Array.isArray(snapshot.body.sessions), 'Missing sessions array');
      sessions = snapshot.body.sessions.filter(session => session.nodeId === NODE_ID);
      return sessions.length > 0;
    }, 'Live Codex registration');
    console.log(JSON.stringify({ check: 'discovery', nodeId: NODE_ID,
      sessions: sessions.map(({ id, provider, status, capabilities }) => ({ id, provider, status, capabilities })) }, null, 2));
    if (sessionId) await verifyRead({ controller, sessions, sessionId });
    console.log('PASS live Go Daemon → PostgreSQL-backed Controller → existing Codex sessions (readonly)');
  }, [
    { label: 'live fixture daemon', cleanup: () => stopTestProcess(daemon) },
    { label: 'live fixture daemon directory', cleanup: () => daemonStateDir && rm(daemonStateDir, { recursive: true, force: true }) },
    { label: 'live fixture Controller', cleanup: () => controller?.stop() },
    { label: 'live fixture PostgreSQL container', cleanup: () => postgres.stop() },
  ]);
}

async function verifyRead({ controller, sessions, sessionId }) {
  const target = sessions.find(session => session.id === sessionId);
  assert(target?.capabilities.includes('read'), 'Requested session does not advertise read capability');
  const payload = { nodeId: NODE_ID, sessionId, action: 'read', requestId: randomUUID() };
  const command = await controller.request('/v1/commands', payload);
  assert([200, 201, 202].includes(command.status), `Read command: HTTP ${command.status}`);
  assert(command.body.commandId, 'Read command did not return commandId');
  const duplicate = await controller.request('/v1/commands', payload);
  assert([200, 201, 202].includes(duplicate.status), `Duplicate read command: HTTP ${duplicate.status}`);
  assert.equal(duplicate.body.commandId, command.body.commandId, 'Duplicate request created another command');
  const deadline = Date.now() + READ_TIMEOUT_MS;
  do {
    const response = await controller.request(`/v1/commands/${encodeURIComponent(command.body.commandId)}`);
    assert.equal(response.status, 200);
    const result = response.body;
    if (['completed', 'failed', 'uncertain'].includes(result.status)) {
      assert.equal(result.status, 'completed', `Read ended in ${result.status}`);
      assert.equal(typeof result.output, 'string', 'Read output must be text');
      console.log(JSON.stringify({ check: 'read-and-dedupe', commandId: result.commandId,
        status: result.status, outputBytes: Buffer.byteLength(result.output) }));
      return;
    }
    await delay(READ_POLL_INTERVAL_MS);
  } while (Date.now() < deadline);
  throw new Error('Read command did not finish within 45 seconds');
}
