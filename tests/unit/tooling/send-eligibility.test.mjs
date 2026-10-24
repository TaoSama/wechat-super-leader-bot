import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runSendEligibilityCli } from '../../support/send-eligibility-cli.mjs';

const local = fileURLToPath(new URL('../../../scripts/local.mjs', import.meta.url));
const live = fileURLToPath(new URL('../../live/session.mjs', import.meta.url));
const nodeId = 'synthetic-node';
const at = (offset = 0) => new Date(Date.now() + offset).toISOString();
const native = () => ({ nodeId, id: 'synthetic-native', provider: 'codex-app', title: 'fixture', cwd: '/fixture',
  status: 'idle', loaded: true, capabilities: ['read', 'send'], observedAt: at() });
const desktop = () => ({ ...native(), id: 'synthetic-desktop', status: 'unknown', loaded: false, capabilities: ['read'],
  desktopObservation: { status: 'idle', availability: 'available', source: 'codex-desktop', observedAt: at() },
  sendAvailability: { route: 'desktop-owner', state: 'ready', observedAt: at(), validUntil: at(30_000) } });
const resume = () => ({ ...native(), id: 'synthetic-resume', status: 'notLoaded', loaded: false, capabilities: ['read', 'resume-send'] });
const terminal = () => ({ ...native(), id: `terminal:${'a'.repeat(43)}`, provider: 'terminal/codex',
  status: 'unknown', loaded: false, capabilities: ['read'],
  sendAvailability: { route: 'terminal-pane', mode: 'non-atomic', state: 'ready', observedAt: at(), validUntil: at(30_000) } });
const statusFor = (sessions, connected = true) => ({ nodes: [{ nodeId, connected }], sessions, commands: [], skills: [] });
const runLive = (session, options = {}, connected = true) => runSendEligibilityCli(live,
  ['--session', session.id, '--node', nodeId, '--timeout', '1000', '--pollInterval', '1'], statusFor([session], connected), options);

test('local diagnostics count fresh native, desktop, resume and terminal eligibility', () => {
  const sessions = [native(), desktop(), resume(), terminal()];
  const status = statusFor(sessions);
  const list = runSendEligibilityCli(local, ['--sessions'], status);
  assert.equal(list.status, 0, list.stderr);
  const listed = JSON.parse(list.stdout).sessions;
  assert.deepEqual(listed.map(session => session.canSendNow), [true, true, true, true]);
  assert.equal(listed[1].status, 'unknown');
  assert.deepEqual(listed[1].capabilities, ['read']);
  assert.match(list.stderr, /FIXTURE_POSTS=0/);

  const check = runSendEligibilityCli(local, ['--check'], status);
  assert.equal(check.status, 0, check.stderr);
  assert.equal(JSON.parse(check.stdout).sendCapableSessionCount, 4);
  assert.match(check.stderr, /FIXTURE_POSTS=0/);
});

test('local diagnostics exclude stale, blocked, unloaded native and disconnected sessions', () => {
  const blocked = desktop();
  blocked.sendAvailability.state = 'blocked';
  blocked.capabilities.push('send');
  blocked.status = 'idle';
  blocked.loaded = true;
  const staleDesktop = desktop();
  staleDesktop.sendAvailability.observedAt = at(-60_000);
  staleDesktop.sendAvailability.validUntil = at(-30_000);
  const staleTerminal = terminal();
  staleTerminal.sendAvailability = { ...staleTerminal.sendAvailability, observedAt: at(-60_000), validUntil: at(-30_000) };
  const sessions = [blocked, staleDesktop, staleTerminal, { ...native(), loaded: false }, { ...native(), observedAt: at(-60_000) }];
  for (const status of [statusFor(sessions), statusFor([native(), desktop(), resume(), terminal()], false)]) {
    const list = runSendEligibilityCli(local, ['--sessions'], status);
    assert.equal(list.status, 0, list.stderr);
    assert(JSON.parse(list.stdout).sessions.every(session => session.canSendNow === false));
    const check = runSendEligibilityCli(local, ['--check'], status);
    assert.equal(check.status, 0, check.stderr);
    assert.equal(JSON.parse(check.stdout).sendCapableSessionCount, 0);
    assert.match(check.stderr, /FIXTURE_POSTS=0/);
  }
});

for (const [route, createSession] of [['desktop-owner', desktop], ['control-socket', native], ['app-server-resume', resume]]) {
  test(`live harness accepts fresh ${route} and verifies completed-turn idempotency`, () => {
    const result = runLive(createSession(), { allowCommands: true });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PASS test-live-session completed all assertions/);
    assert.match(result.stdout, /"markerVerified": true/);
    assert.match(result.stderr, /FIXTURE_POSTS=3/);
  });
}

test('live harness rejects terminal input-only receipts before any command POST', () => {
  const result = runLive(terminal());
  assert.equal(result.status, 1);
  assert.match(result.stderr, /terminal-pane reports input-written only/);
  assert.match(result.stderr, /FIXTURE_POSTS=0/);
});

test('live harness rejects unavailable, stale and disconnected targets before submission', () => {
  const busy = desktop();
  busy.desktopObservation.status = 'active';
  const revoked = desktop();
  revoked.sendAvailability.state = 'blocked';
  const expired = desktop();
  expired.sendAvailability = { ...expired.sendAvailability, observedAt: at(-60_000), validUntil: at(-30_000) };
  for (const session of [busy, revoked, expired, { ...native(), loaded: false }, { ...native(), observedAt: at(-60_000) }]) {
    const result = runLive(session);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Session cannot send now/);
    assert.match(result.stderr, /FIXTURE_POSTS=0/);
  }
  const disconnected = runLive(desktop(), {}, false);
  assert.equal(disconnected.status, 1);
  assert.match(disconnected.stderr, /currently disconnected/);
  assert.match(disconnected.stderr, /FIXTURE_POSTS=0/);
});

test('live harness still requires completed output from completed-turn routes', () => {
  const result = runLive(desktop(), { allowCommands: true, commandStatus: 'failed' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /non-completed status: failed/);
  assert.doesNotMatch(result.stdout, /PASS test-live-session/);
  assert.match(result.stderr, /FIXTURE_POSTS=2/);
});
