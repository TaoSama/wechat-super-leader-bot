import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const { values } = parseArgs({ options: {
  help: { type: 'boolean', short: 'h' },
  url: { type: 'string', default: 'http://127.0.0.1:8790' },
  node: { type: 'string', default: 'demoair' },
  session: { type: 'string' },
} });

if (values.help) {
  console.log('Usage: node scripts/check-control-plane.mjs [--url URL] [--node demoair] [--session ID]\nRequires CONTROLLER_TOKEN. Checks auth and discovery; optionally reads one session. Never sends a prompt.');
} else {
  try { await check(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

async function check() {
  const base = new URL(values.url);
  assert(!base.username && !base.password && !base.search && !base.hash, 'URL must not contain credentials, query parameters or fragments');
  assert(base.protocol === 'https:' || (base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)), 'Remote Controller requires HTTPS');
  const token = process.env.CONTROLLER_TOKEN;
  assert(token, 'CONTROLLER_TOKEN is required');
  const request = async (path, options = {}) => {
    const response = await fetch(new URL(path, base), {
      ...options,
      redirect: 'error',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    assert(response.ok, `${path}: HTTP ${response.status}`);
    return response.json();
  };
  await request('/health');
  const unauthenticated = await fetch(new URL('/v1/status', base), { redirect: 'error', signal: AbortSignal.timeout(15_000) });
  assert([401, 403].includes(unauthenticated.status), 'Unauthenticated status access was not rejected');
  const snapshot = await request('/v1/status');
  assert(Array.isArray(snapshot.sessions), 'Missing sessions array');
  const sessions = snapshot.sessions.filter(session => session.nodeId === values.node);
  console.log(JSON.stringify({ check: 'discovery', nodeId: values.node, sessions: sessions.map(({ id, provider, status, capabilities }) => ({ id, provider, status, capabilities })) }, null, 2));
  assert(sessions.length > 0, `No sessions discovered on ${values.node}`);
  if (!values.session) return;
  const target = sessions.find(session => session.id === values.session);
  assert(target?.capabilities.includes('read'), 'Requested session does not advertise read capability');
  const payload = { nodeId: values.node, sessionId: values.session, action: 'read', requestId: randomUUID() };
  const command = await request('/v1/commands', { method: 'POST', body: JSON.stringify(payload) });
  const duplicate = await request('/v1/commands', { method: 'POST', body: JSON.stringify(payload) });
  assert.equal(duplicate.commandId, command.commandId, 'Duplicate request created another command');
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const result = await request(`/v1/commands/${encodeURIComponent(command.commandId)}`);
    if (['completed', 'failed', 'uncertain'].includes(result.status)) {
      assert.equal(result.status, 'completed', `Read ended in ${result.status}`);
      assert.equal(typeof result.output, 'string', 'Read output must be text');
      console.log(JSON.stringify({ check: 'read-and-dedupe', commandId: command.commandId, status: result.status, outputBytes: Buffer.byteLength(result.output) }));
      return;
    }
    await delay(250);
  }
  throw new Error('Read command did not finish within 45 seconds');
}
