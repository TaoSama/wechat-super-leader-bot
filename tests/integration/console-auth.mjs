import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { withTestCleanup } from '../support/cleanup.mjs';

const { values } = parseArgs({
  options: {
    help: { type: 'boolean', short: 'h' },
    run: { type: 'boolean', short: 'r' },
  },
  allowPositionals: false,
});

if (values.help || !values.run) {
  console.log(`Usage: node tests/integration/console-auth.mjs [--run] [--help]
Options:
  --run, -r   Run the real PostgreSQL console authentication integration tests.
  --help, -h  Show this help message.

When run without --run, performs argument/environment check and exits successfully.
Requires built controller/dist, Docker with postgres:16-alpine.
Uses an isolated temporary container with random name/port/password and cleans up on exit.
Never touches production or existing databases, daemons, or WeChat gateways.`);
  process.exit(0);
}

await main().catch((error) => {
  const safeMessage = error instanceof Error
    ? `${error.name}: ${error.message.split('\n')[0]}`
    : 'Unknown test failure';
  console.error('Test suite failed:', safeMessage);
  process.exitCode = 1;
});

async function main() {
  const { PostgresStore } = await import('../../controller/dist/store/postgres.js');
  const { ControllerServer } = await import('../../controller/dist/http/server.js');
  const { ConsoleAuthService } = await import('../../controller/dist/console/auth.js');

  const password = randomBytes(24).toString('hex');
  const controllerToken = randomBytes(24).toString('hex');
  const nodeToken = randomBytes(24).toString('hex');
  const containerName = `super-leader-console-test-${randomUUID()}`;

  const docker = (args) => execFileSync('docker', args, {
    encoding: 'utf8',
    env: { ...process.env, POSTGRES_PASSWORD: password },
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

  let containerCreated = false;
  let activeServer = null;

  await withTestCleanup(async () => {
    console.log(`[1/8] Starting isolated PostgreSQL container: ${containerName}`);
    docker([
      'run', '--detach', '--rm', '--name', containerName,
      '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_USER=leader', '-e', 'POSTGRES_DB=leader',
      '-p', '127.0.0.1::5432', 'postgres:16-alpine',
    ]);
    containerCreated = true;

    const dbPort = docker(['port', containerName, '5432/tcp']).split(':').at(-1);
    const databaseUrl = `postgresql://leader:${password}@127.0.0.1:${dbPort}/leader`;

    await waitFor(async () => {
      try {
        docker(['exec', containerName, 'pg_isready', '-h', '127.0.0.1', '-U', 'leader', '-d', 'leader']);
        return true;
      } catch (error) {
        if (error.status === 1 || error.status === 2) return false;
        throw error;
      }
    }, 'PostgreSQL readiness');

    const findAvailablePort = async () => {
      const reservation = createServer();
      reservation.listen(0, '127.0.0.1');
      await once(reservation, 'listening');
      const port = reservation.address().port;
      await new Promise((resolve, reject) => reservation.close((err) => (err ? reject(err) : resolve())));
      return port;
    };

    const serverPort = await findAvailablePort();
    const publicUrl = `http://127.0.0.1:${serverPort}`;

    const makeConfig = (override = {}) => ({
      port: serverPort,
      host: '127.0.0.1',
      controllerToken,
      nodeTokens: Object.assign(Object.create(null), { 'test-node': nodeToken }),
      tokenToNode: new Map([[nodeToken, 'test-node']]),
      allowedChatIds: new Set(['test-chat']),
      persistenceMode: 'postgres',
      databaseUrl,
      commandTtlSeconds: 300,
      consolePublicUrl: publicUrl,
      ...override,
    });

    console.log('[2/8] Testing dual-client Store-level PG operations, rollback, and hash-only persistence');
    const store1 = new PostgresStore(databaseUrl);
    const store2 = new PostgresStore(databaseUrl);

    const assertDbHasOnlyHashes = () => {
      const linksOut = docker([
        'exec', containerName, 'psql', '-U', 'leader', '-d', 'leader', '-t', '-A',
        '-c', 'SELECT token_hash FROM console_links'
      ]);
      const sessionsOut = docker([
        'exec', containerName, 'psql', '-U', 'leader', '-d', 'leader', '-t', '-A',
        '-c', 'SELECT token_hash FROM console_sessions'
      ]);
      const linkHashes = linksOut.split('\n').map((s) => s.trim()).filter(Boolean);
      const sessionHashes = sessionsOut.split('\n').map((s) => s.trim()).filter(Boolean);
      assert(linkHashes.length > 0, 'Must have at least one link hash in database');
      assert(sessionHashes.length > 0, 'Must have at least one session hash in database');
      for (const hash of [...linkHashes, ...sessionHashes]) {
        assert(/^[0-9a-f]{64}$/.test(hash), `Value '${hash}' is not a valid 64-char sha256 hex digest`);
      }
    };

    await withTestCleanup(async () => {
      // Sequential schema initialization avoids PostgreSQL DDL catalog race on CREATE IF NOT EXISTS
      await store1.init();
      await store2.init();
      const linkRaw = 'test-token-' + randomUUID();
      const tokenHash = createHash('sha256').update(linkRaw, 'utf8').digest('hex');
      const nowMs = Date.now();
      const createdAt = new Date(nowMs).toISOString();
      const expiresAt = new Date(nowMs + 3600_000).toISOString();

      const created1 = await store1.createConsoleLinkIfAbsent({ tokenHash, createdAt, expiresAt });
      assert.equal(created1.tokenHash, tokenHash);
      assert.equal(created1.consumedAt, undefined);

      const created2 = await store2.createConsoleLinkIfAbsent({ tokenHash, createdAt, expiresAt });
      assert.equal(created2.tokenHash, tokenHash);

      const sessionRaw = 'session-token-' + randomUUID();
      const sessionHash = createHash('sha256').update(sessionRaw, 'utf8').digest('hex');
      const sessionRecord = {
        tokenHash: sessionHash,
        createdAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(nowMs + 3600_000).toISOString(),
      };

      const consumeResults = await Promise.all([
        store1.consumeConsoleLink(tokenHash, sessionRecord, new Date(nowMs).toISOString()),
        store2.consumeConsoleLink(tokenHash, sessionRecord, new Date(nowMs).toISOString()),
      ]);
      const successes = consumeResults.filter(Boolean);
      assert.equal(successes.length, 1, 'Dual-store concurrent link consumption must yield exactly 1 winner');

      const activeSession = await store1.getConsoleSession(sessionHash, new Date(nowMs).toISOString());
      assert(activeSession, 'Active session must be retrieved from database');
      assert.equal(activeSession.tokenHash, sessionHash);

      const secondActive = await store2.getConsoleSession(sessionHash, new Date(nowMs).toISOString());
      assert.deepEqual(activeSession, secondActive, 'Both store instances must see identical shared session');

      // Test real transaction rollback: attempt to consume another link with the already existing sessionHash
      const rollbackLinkRaw = 'rollback-token-' + randomUUID();
      const rollbackTokenHash = createHash('sha256').update(rollbackLinkRaw, 'utf8').digest('hex');
      await store1.createConsoleLinkIfAbsent({
        tokenHash: rollbackTokenHash,
        createdAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(nowMs + 3600_000).toISOString(),
      });

      const conflictingSessionRecord = {
        tokenHash: sessionHash, // Conflict in console_sessions primary key
        createdAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(nowMs + 3600_000).toISOString(),
      };

      let conflictErrorThrown = false;
      try {
        await store1.consumeConsoleLink(rollbackTokenHash, conflictingSessionRecord, new Date(nowMs).toISOString());
      } catch {
        conflictErrorThrown = true;
      }
      assert.equal(conflictErrorThrown, true, 'Consuming link with duplicate session tokenHash must throw on insert');

      const checkUnconsumed = docker([
        'exec', containerName, 'psql', '-U', 'leader', '-d', 'leader', '-t', '-A',
        '-c', `SELECT consumed_at IS NULL FROM console_links WHERE token_hash = '${rollbackTokenHash}'`
      ]);
      assert.equal(checkUnconsumed.trim(), 't', 'Transaction rollback must leave console_link unconsumed');

      const freshSessionRaw = 'fresh-session-' + randomUUID();
      const freshSessionHash = createHash('sha256').update(freshSessionRaw, 'utf8').digest('hex');
      const freshSessionRecord = {
        tokenHash: freshSessionHash,
        createdAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(nowMs + 3600_000).toISOString(),
      };
      const consumedAfterRollback = await store1.consumeConsoleLink(
        rollbackTokenHash,
        freshSessionRecord,
        new Date(nowMs).toISOString()
      );
      assert.equal(consumedAfterRollback, true, 'Link must be consumable with a fresh sessionHash after rollback');

      assertDbHasOnlyHashes();

      const expiredCheck = await store1.getConsoleSession(sessionHash, new Date(nowMs + 7200_000).toISOString());
      assert.equal(expiredCheck, null, 'Expired session must return null');

      await store2.deleteConsoleSession(sessionHash);
      assert.equal(await store1.getConsoleSession(sessionHash, new Date(nowMs).toISOString()), null);
    }, [
      { label: 'console PostgreSQL store 1', cleanup: () => store1.close() },
      { label: 'console PostgreSQL store 2', cleanup: () => store2.close() },
    ]);
    console.log('PASS dual-store PG atomicity, rollback on session conflict, hash-only verification, and session lifecycle');

    console.log('[3/8] Testing ConsoleAuthService 1h link expiration with injected clock');
    let simulatedTime = Date.now();
    const clockStore = new PostgresStore(databaseUrl);
    await withTestCleanup(async () => {
      await clockStore.init();
      const authService = new ConsoleAuthService(
        clockStore,
        publicUrl,
        controllerToken,
        () => simulatedTime
      );

      const issued = await authService.issueLink('expire-req-1');
      assert(issued.url.includes('#login='));
      const token = issued.url.split('#login=')[1];
      assert(token && token.length > 0);

      simulatedTime += 3600_000 + 1000;

      const exchanged = await authService.exchangeToken(token);
      assert.equal(exchanged, null, 'Exchanging token after 1 hour must fail (return null)');

      const issued2 = await authService.issueLink('valid-req-2');
      const token2 = issued2.url.split('#login=')[1];
      const validExchange = await authService.exchangeToken(token2);
      assert(validExchange, 'Exchanging fresh token must succeed');

      const verified = await authService.verifySession(validExchange.sessionToken);
      assert(verified, 'Fresh session must be verified');

      simulatedTime += 3600_000 + 1000;
      const expiredSession = await authService.verifySession(validExchange.sessionToken);
      assert.equal(expiredSession, null, 'Session must expire after 1 hour');
    }, [{ label: 'console clock PostgreSQL store', cleanup: () => clockStore.close() }]);
    console.log('PASS ConsoleAuthService 1-hour expiration for link and session via injected clock');

    console.log('[4/8] Starting ControllerServer and testing link issuance and exchange');
    let serverNow = Date.now();
    const controllerStore = new PostgresStore(databaseUrl);
    const server = new ControllerServer(makeConfig(), controllerStore, undefined, () => serverNow);
    activeServer = server;
    await server.start();

    const base = `http://127.0.0.1:${serverPort}`;

    const postJson = async (path, body, headers = {}) => {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...headers,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
      const json = await res.json();
      return { status: res.status, headers: res.headers, body: json };
    };

    const getJson = async (path, headers = {}) => {
      const res = await fetch(`${base}${path}`, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(5000),
      });
      const json = await res.json();
      return { status: res.status, headers: res.headers, body: json };
    };

    const issueResNoAuth = await postJson('/v1/console-links', { requestId: 'unauth-req' });
    assert.equal(issueResNoAuth.status, 401, 'POST /v1/console-links without token must return 401');

    const issueRes = await postJson(
      '/v1/console-links',
      { requestId: 'req-alpha' },
      { authorization: `Bearer ${controllerToken}` }
    );
    assert.equal(issueRes.status, 200);
    assert(issueRes.body.url.startsWith(`${publicUrl}/#login=`));
    const tokenAlpha = issueRes.body.url.split('#login=')[1];

    const issueResDifferent = await postJson(
      '/v1/console-links',
      { requestId: 'req-beta' },
      { authorization: `Bearer ${controllerToken}` }
    );
    assert.equal(issueResDifferent.status, 200);
    const tokenBeta = issueResDifferent.body.url.split('#login=')[1];
    assert.notEqual(tokenAlpha, tokenBeta, 'Different requestId must produce distinct links');

    console.log('[5/8] Testing concurrent token exchange (at least 8 parallel requests -> exactly 1 succeeds)');
    const exchangeAttempts = await Promise.all(
      Array.from({ length: 8 }, () =>
        postJson('/auth/exchange', { token: tokenAlpha }, { origin: publicUrl })
      )
    );

    const successExchanges = exchangeAttempts.filter((res) => res.status === 200);
    const failedExchanges = exchangeAttempts.filter((res) => res.status === 401);
    assert.equal(successExchanges.length, 1, 'Exactly one concurrent exchange must succeed');
    assert.equal(failedExchanges.length, 7, 'All other concurrent exchanges must return 401');

    const successRes = successExchanges[0];
    assert.equal(successRes.body.authenticated, true);
    assert(successRes.headers.get('cache-control')?.includes('no-store'));
    assert.equal(successRes.headers.get('referrer-policy'), 'no-referrer');

    const setCookie = successRes.headers.get('set-cookie');
    assert(setCookie, 'Exchange response must set session cookie');
    assert(setCookie.includes('HttpOnly'), 'Cookie must be HttpOnly');
    assert(setCookie.includes('SameSite=Strict') || setCookie.includes('samesite=strict'), 'Cookie must be SameSite=Strict');
    assert(setCookie.includes('Path=/'), 'Cookie must have Path=/');

    const sessionCookie = setCookie.split(';')[0];

    const replayRes = await postJson('/auth/exchange', { token: tokenAlpha }, { origin: publicUrl });
    assert.equal(replayRes.status, 401, 'Replaying consumed token must fail with 401');

    console.log('[6/8] Testing /auth/session, /auth/logout, and cookie vs bearer permissions');
    const sessionRes = await getJson('/auth/session', { cookie: sessionCookie });
    assert.equal(sessionRes.status, 200);
    assert.equal(sessionRes.body.authenticated, true);

    const statusWithCookie = await getJson('/v1/status', { cookie: sessionCookie });
    assert.equal(statusWithCookie.status, 200, 'GET /v1/status must succeed with cookie');
    assert(Array.isArray(statusWithCookie.body.nodes));

    const skillsWithCookie = await getJson('/v1/skills', { cookie: sessionCookie });
    assert.equal(skillsWithCookie.status, 200, 'GET /v1/skills must succeed with cookie');

    const commandReadWithCookie = await getJson('/v1/commands/non-existent-cmd', { cookie: sessionCookie });
    assert.equal(commandReadWithCookie.status, 404, 'GET /v1/commands/:id must be permitted with cookie (404 expected)');

    const postCommandWithCookie = await postJson(
      '/v1/commands',
      { nodeId: 'test-node', sessionId: 'test-session', action: 'read', requestId: randomUUID() },
      { cookie: sessionCookie }
    );
    assert.equal(postCommandWithCookie.status, 401, 'POST /v1/commands with cookie must be rejected (401)');

    const issueLinkWithCookie = await postJson(
      '/v1/console-links',
      { requestId: 'illegal-cookie-issue' },
      { cookie: sessionCookie }
    );
    assert.equal(issueLinkWithCookie.status, 401, 'POST /v1/console-links with cookie must be rejected (401)');

    console.log('[7/8] Testing Controller restart persistence (consumed link remains consumed, session valid)');
    await server.stop();
    activeServer = null;

    const restartedStore = new PostgresStore(databaseUrl);
    const restartedServer = new ControllerServer(makeConfig(), restartedStore, undefined, () => serverNow);
    activeServer = restartedServer;
    await restartedServer.start();

    const replayAfterRestart = await postJson('/auth/exchange', { token: tokenAlpha }, { origin: publicUrl });
    assert.equal(replayAfterRestart.status, 401, 'Consumed token must remain 401 across Controller restarts');

    const sessionAfterRestart = await getJson('/auth/session', { cookie: sessionCookie });
    assert.equal(sessionAfterRestart.status, 200, 'Session must remain valid across Controller restarts');

    const secondLinkExchange = await postJson('/auth/exchange', { token: tokenBeta }, { origin: publicUrl });
    assert.equal(secondLinkExchange.status, 200, 'Unconsumed link from before restart must still exchange successfully');
    const betaCookie = secondLinkExchange.headers.get('set-cookie').split(';')[0];

    const logoutRes = await postJson('/auth/logout', {}, { origin: publicUrl, cookie: betaCookie });
    assert.equal(logoutRes.status, 200);
    assert.equal(logoutRes.body.authenticated, false);

    const checkBetaLoggedOut = await getJson('/auth/session', { cookie: betaCookie });
    assert.equal(checkBetaLoggedOut.status, 401, 'Logged out session must return 401');

    await restartedServer.stop();
    activeServer = null;

    console.log('[8/8] PASS ALL PostgreSQL-backed console authentication integration assertions!');
  }, [
    { label: 'console Controller', cleanup: () => activeServer && activeServer.stop() },
    { label: 'console PostgreSQL container', cleanup: () => {
      if (!containerCreated) return;
      console.log(`Cleaning up test container: ${containerName}`);
      docker(['stop', '--time', '5', containerName]);
      console.log(`Test container cleaned up successfully: ${containerName}`);
    } },
  ]);
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 25_000;
  do {
    if (await predicate()) return;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}
