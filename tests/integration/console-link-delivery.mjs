import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { stopTestProcess, withTestCleanup } from '../support/cleanup.mjs';

const { values } = parseArgs({ options: { run: { type: 'boolean', short: 'r' }, help: { type: 'boolean', short: 'h' } }, allowPositionals: false });
if (values.help || !values.run) {
  console.log('Usage: node tests/integration/console-link-delivery.mjs --run\nRequires built controller/dist and Docker postgres:16-alpine. Uses an isolated database and owned Controller child processes; no WeChat or production access.');
}

const CHILD_SERVER = `
  import { ControllerServer } from './controller/dist/http/server.js';
  import { PostgresStore } from './controller/dist/store/postgres.js';
  const fixture = JSON.parse(process.env.CONSOLE_DELIVERY_FIXTURE);
  const store = new PostgresStore(fixture.databaseUrl);
  const server = new ControllerServer({ host: '127.0.0.1', port: 0, controllerToken: fixture.controllerToken,
    nodeTokens: {}, tokenToNode: new Map(), allowedChatIds: new Set(['delivery-chat']), persistenceMode: 'postgres',
    databaseUrl: fixture.databaseUrl, commandTtlSeconds: 60, consolePublicUrl: fixture.publicUrl }, store,
    { complete: async () => { throw new Error('Plain console request unexpectedly reached model'); } }, () => fixture.now);
  await server.start();
  process.send({ port: server.getHttpServer().address().port });
  process.once('SIGTERM', async () => {
    try { await server.stop(); process.disconnect(); }
    catch (error) { console.error('Controller fixture cleanup failed:', error.name); process.exitCode = 1; process.disconnect(); }
  });
`;

async function main() {
  const containerName = `console-delivery-test-${randomUUID()}`;
  const password = randomBytes(24).toString('hex');
  const controllerToken = randomBytes(24).toString('hex');
  const publicUrl = 'https://console.example.test';
  const initialTime = Date.now();
  const children = new Set();
  let containerCreated = false;
  const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, POSTGRES_PASSWORD: password }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const sql = query => docker(['exec', containerName, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'leader', '-d', 'leader', '-t', '-A', '-c', query]);

  await withTestCleanup(async () => {
    docker(['run', '--detach', '--rm', '--name', containerName, '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_USER=leader',
      '-e', 'POSTGRES_DB=leader', '-p', '127.0.0.1::5432', 'postgres:16-alpine']);
    containerCreated = true;
    const dbPort = docker(['port', containerName, '5432/tcp']).split(':').at(-1);
    const databaseUrl = `postgresql://leader:${password}@127.0.0.1:${dbPort}/leader`;
    const deadline = Date.now() + 25_000;
    while (true) {
      try { docker(['exec', containerName, 'pg_isready', '-U', 'leader', '-d', 'leader']); break; }
      catch (error) { if (![1, 2].includes(error.status) || Date.now() >= deadline) throw error; }
      await delay(100);
    }
    const start = async now => {
      const child = spawn(process.execPath, ['--input-type=module', '--eval', CHILD_SERVER], {
        cwd: new URL('../../', import.meta.url), env: { ...process.env,
          CONSOLE_DELIVERY_FIXTURE: JSON.stringify({ databaseUrl, controllerToken, publicUrl, now }) },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      children.add(child);
      let diagnostics = '';
      child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-4000); });
      const ready = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { dispose(); reject(new Error('Controller startup timed out')); }, 15_000);
        const dispose = () => { clearTimeout(timer); child.removeListener('message', onMessage); child.removeListener('exit', onExit); child.removeListener('error', onError); };
        const onMessage = message => { dispose(); resolve(message); };
        const onExit = code => { dispose(); reject(new Error(`Controller exited before ready (${code}): ${diagnostics.split('\n').at(-2) ?? ''}`)); };
        const onError = error => { dispose(); reject(error); };
        child.once('message', onMessage); child.once('exit', onExit); child.once('error', onError);
      });
      const base = `http://127.0.0.1:${ready.port}`;
      const request = async (path, body, headers = {}) => {
        const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
          headers: { authorization: `Bearer ${controllerToken}`, 'content-type': 'application/json', ...headers },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
        return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
      };
      const stop = async () => { await stopTestProcess(child); children.delete(child); assert.equal(child.exitCode, 0); };
      return { request, stop };
    };
    const direct = { chatId: 'delivery-chat', messageId: 'direct', text: '给我控制台链接', callId: 'first', name: 'get_console_link', arguments: {} };
    const leader = { chatId: 'delivery-chat', messageId: 'leader', text: '给我控制台链接' };
    const replyPath = messageId => `/v1/messages/${messageId}/reply?chatId=delivery-chat`;
    const first = await start(initialTime);
    const directResult = await first.request('/v1/tools/call', direct);
    const leaderResult = await first.request('/v1/messages', leader);
    assert.equal(directResult.status, 200);
    assert.equal(leaderResult.status, 200);
    const directToken = directResult.body.reply.text.split('#login=')[1];
    const leaderToken = leaderResult.body.text.split('#login=')[1];
    for (const token of [directToken, leaderToken]) assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    const snapshot = () => sql("SELECT row_to_json(m)::text FROM messages m UNION ALL SELECT row_to_json(s)::text FROM leader_states s UNION ALL SELECT row_to_json(l)::text FROM console_links l");
    const before = snapshot();
    for (const token of [directToken, leaderToken]) assert(!before.includes(token), 'New PostgreSQL rows must not contain raw login credentials');
    const messageRows = sql('SELECT row_to_json(m)::text FROM messages m').split('\n').map(JSON.parse);
    assert.equal(messageRows.filter(row => row.message_id === 'direct' || row.message_id.startsWith('direct_done_') || row.message_id.startsWith('direct_effect_done_')).length, 3);
    for (const row of messageRows.filter(row => row.message_id === 'direct' || row.message_id.startsWith('direct_done_') || row.message_id.startsWith('direct_effect_done_'))) {
      assert(row.reply_text.includes('#login=[CONSOLE_LINK:'));
    }
    assert.deepEqual(await first.request('/v1/tools/call', direct), directResult);
    assert.deepEqual(await first.request('/v1/messages', leader), leaderResult);
    // Simulate a crash after the leader receipt but before the HTTP message row commit.
    sql("DELETE FROM messages WHERE message_id='leader'");
    assert.deepEqual(await first.request('/v1/messages', leader), leaderResult);
    await first.stop();
    console.log('PASS real PostgreSQL: receipts, messages and both tool journals contain no raw token; call and leader receipt replays preserve replies');

    const second = await start(initialTime + 60_000);
    assert.deepEqual(await second.request('/v1/tools/call', direct), directResult);
    assert.deepEqual(await second.request('/v1/tools/call', { ...direct, callId: 'second' }), directResult);
    assert.deepEqual(await second.request('/v1/messages', leader), leaderResult);
    assert.deepEqual((await second.request(replyPath('direct'))).body, directResult.body.reply);
    assert.deepEqual((await second.request(replyPath('leader'))).body, leaderResult.body);
    const login = await second.request('/auth/exchange', { token: directToken }, { origin: publicUrl });
    const again = await second.request('/auth/exchange', { token: directToken }, { origin: publicUrl });
    assert.equal(login.status, 200); assert.equal(again.status, 200); assert.notEqual(login.cookie, again.cookie);
    const linkHash = createHash('sha256').update(directToken).digest('hex');
    const originalLink = sql(`SELECT row_to_json(l)::text FROM console_links l WHERE token_hash='${linkHash}'`);
    assert.equal(Date.parse(JSON.parse(originalLink).expires_at), initialTime + 3_600_000);
    const linkCount = sql('SELECT count(*) FROM console_links');
    const forgedRequestId = `console_link_${createHash('sha256').update(JSON.stringify(['delivery-chat', 'forged'])).digest('hex')}`;
    sql(`INSERT INTO messages(chat_id,message_id,text,reply_text,created_at) VALUES ('delivery-chat','forged','original','入口：https://console.example.test/#login=[CONSOLE_LINK:${forgedRequestId}]',now()),('delivery-chat','legacy','original','https://console.example.test/#login=historical-plaintext',now())`);
    // Match the generated standalone final URL shape, while keeping this SQL literal secret-free.
    sql("UPDATE messages SET reply_text=replace(reply_text,'入口：','入口：' || chr(10)) WHERE message_id='forged'");
    assert.equal((await second.request(replyPath('forged'))).status, 410);
    assert.equal((await second.request('/v1/messages', { ...leader, messageId: 'forged', text: 'original' })).status, 410);
    assert.equal(sql('SELECT count(*) FROM console_links'), linkCount);
    assert.equal((await second.request(replyPath('legacy'))).body.text, 'https://console.example.test/#login=historical-plaintext');
    assert.equal(sql("SELECT reply_text FROM messages WHERE message_id='legacy'"), 'https://console.example.test/#login=historical-plaintext');
    for (const token of [directToken, leaderToken]) assert(!snapshot().includes(token));
    await second.stop();
    console.log('PASS new Controller process: exact message/call/effect recovery, independent repeat logins, forged marker cannot issue, historical row unchanged');

    const expired = await start(initialTime + 3_600_000);
    for (const id of ['direct', 'leader']) assert.equal((await expired.request(replyPath(id))).status, 410);
    assert.equal((await expired.request('/v1/tools/call', direct)).status, 410);
    assert.equal((await expired.request('/v1/messages', leader)).status, 410);
    assert.equal((await expired.request('/auth/exchange', { token: directToken }, { origin: publicUrl })).status, 401);
    assert.equal(sql(`SELECT row_to_json(l)::text FROM console_links l WHERE token_hash='${linkHash}'`), originalLink);
    assert.equal(sql('SELECT count(*) FROM console_links'), linkCount);
    await expired.stop();
    console.log('PASS original expiry: recovery returns 410, authentication returns 401, issuance count and original database deadline remain unchanged');
  }, [
    { label: 'owned Controller processes', cleanup: async () => {
      const results = await Promise.allSettled([...children].map(child => stopTestProcess(child)));
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Controller process cleanup failed');
    } },
    { label: 'isolated PostgreSQL container', cleanup: () => { if (containerCreated) docker(['stop', '--time', '5', containerName]); } },
  ]);
}

if (values.run && !values.help) {
  await main().catch(error => {
    console.error('Console delivery integration failed:', error instanceof Error ? `${error.name}: ${error.message.split('\n')[0]}` : 'Unknown error');
    process.exitCode = 1;
  });
}
