import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { verificationEnvironment, PROJECT_ROOT } from '../../../scripts/verify.mjs';
import { withTestCleanup } from '../../support/cleanup.mjs';
import { createReliabilityPostgresFixture } from '../../support/reliability-postgres.mjs';
import { Pool, withReliabilityFixture, writeReport } from './fixture.mjs';
import { queueScenarios } from './queue.mjs';
import { recoveryScenarios } from './recovery.mjs';
import { gatewayScenarios } from './gateway.mjs';

const { values } = parseArgs({ options: { run: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  scenario: { type: 'string' }, evidence: { type: 'string', default: '.runtime/verification/reliability-e2e' } } });
const scenarios = [...queueScenarios, ...recoveryScenarios, ...gatewayScenarios];

if (values.help || !values.run) {
  console.log('Usage: node tests/integration/reliability/run.mjs --run [--scenario NAME] [--evidence DIRECTORY]\n' +
    'Requires built Controller/Gateway, daemon/bin/super-leader-daemon, OpenSSL, and local Docker with postgres:16-alpine.\n' +
    'Starts real processes and disposable durable PostgreSQL; all native sessions and WeChat endpoints are synthetic.\n' +
    'Faults target only child handles, owned proxies, temporary state and databases. Never reads live credentials or deploys.\n' +
    'Scenarios: ' + scenarios.map(([name]) => name).join(', '));
} else {
  await main().catch(error => { console.error(error.stack); process.exitCode = 1; });
}

async function main() {
  const chosen = values.scenario ? scenarios.filter(([name]) => name === values.scenario) : scenarios;
  if (!chosen.length) throw new Error('Unknown scenario: ' + values.scenario);
  const directory = resolve(PROJECT_ROOT, values.evidence);
  mkdirSync(directory, { recursive: true });
  const eventPath = resolve(directory, 'events.jsonl');
  writeFileSync(eventPath, '');
  const events = [], results = [];
  const stop = new AbortController();
  const onSignal = signal => {
    if (stop.signal.aborted) return;
    stop.abort(new Error('Reliability run interrupted: ' + signal));
    console.error('[reliability] Stop requested; cleaning up owned fixture resources after the active operation exits.');
  };
  const onInterrupt = () => onSignal('SIGINT'), onTerminate = () => onSignal('SIGTERM');
  process.on('SIGINT', onInterrupt); process.on('SIGTERM', onTerminate);
  let admin, currentScenario, cleanupComplete = false, fixtureCleanupFailed = false;
  const startedAt = new Date().toISOString();
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).trim();
  const sourceDirty = execFileSync('git', ['status', '--porcelain'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).trim().length > 0;
  const evidence = (event, details = {}) => {
    if (event === 'scenario-cleanup-failure') fixtureCleanupFailed = true;
    const item = { at: new Date().toISOString(), scenario: currentScenario, event, ...details };
    events.push(item);
    appendFileSync(eventPath, JSON.stringify(item) + '\n');
  };
  const postgres = createReliabilityPostgresFixture({ env: verificationEnvironment(), evidence });
  await writeReport(directory, report(), events);
  try { await withTestCleanup(async () => {
    const databaseUrl = await postgres.start();
    admin = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000, query_timeout: 10_000 });
    for (const [name, operation] of chosen) {
      if (stop.signal.aborted) break;
      currentScenario = name;
      const scenarioStarted = Date.now();
      console.log(JSON.stringify({ scenario: name, status: 'RUNNING' }));
      const database = 'reliability_' + randomUUID().replaceAll('-', '');
      // Name is generated here, never supplied by the CLI or read from production.
      await admin.query(`CREATE DATABASE "${database}"`);
      const scenarioUrl = new URL(databaseUrl); scenarioUrl.pathname = '/' + database;
      try {
        await withReliabilityFixture({ databaseUrl: scenarioUrl.toString(), evidence, name, signal: stop.signal }, operation);
        results.push({ name, verdict: 'PASS', durationMs: Date.now() - scenarioStarted });
      } catch (error) {
        const failure = { message: error.message, stack: error.stack,
          ...(error.errors ? { causes: error.errors.map(item => ({ message: item.message, stack: item.stack })) } : {}) };
        evidence('failure', failure);
        results.push({ name, verdict: 'FAIL', durationMs: Date.now() - scenarioStarted, failure });
      } finally {
        await admin.query(`DROP DATABASE "${database}"`);
      }
      console.log(JSON.stringify(results.at(-1)));
      await writeReport(directory, report(), events);
    }
  }, [
    { label: 'database admin', cleanup: () => admin?.end() },
    { label: 'owned PostgreSQL container', cleanup: () => postgres.stop() },
    { label: 'signal handlers', cleanup: () => { process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onTerminate); } },
  ]);
    cleanupComplete = !fixtureCleanupFailed;
    evidence(cleanupComplete ? 'cleanup-complete' : 'cleanup-incomplete', { temporaryProcessesAndDatabasesRemoved: cleanupComplete });
  } catch (error) {
    evidence('infrastructure-failure', { message: error.message, stack: error.stack });
    results.push({ name: 'infrastructure-or-cleanup', verdict: 'FAIL', failure: { message: error.message, stack: error.stack } });
  }
  const final = report(true);
  await writeReport(directory, final, events);
  console.log(JSON.stringify({ verdict: final.verdict, passed: final.passed, failed: final.failed, evidenceDirectory: directory }));
  if (final.verdict !== 'PASS') process.exitCode = 1;

  function report(final = false) {
    return { verdict: !final ? 'RUNNING' : stop.signal.aborted || !cleanupComplete || results.length !== chosen.length || results.some(item => item.verdict === 'FAIL') ? 'FAIL' : 'PASS', startedAt,
      ...(final ? { finishedAt: new Date().toISOString() } : {}), sourceCommit, sourceDirty, gatewayLeaderMode: 'controller',
      expectedScenarios: chosen.length, completedScenarios: results.filter(item => item.name !== 'infrastructure-or-cleanup').length, cleanupComplete,
      interrupted: stop.signal.aborted,
      boundaries: { real: ['Gateway CLI', 'Controller HTTP/WS process', 'Go Daemon process', 'PostgreSQL', 'Gateway state files', 'Daemon bbolt journal'],
        synthetic: ['WeChat iLink HTTPS endpoint', 'Codex app-server Unix WebSocket', 'model Responses endpoint'],
        unproven: ['physical phone receipt/read', 'live WeChat service outage', 'real Codex desktop owner', 'power loss or disk corruption',
          'Gateway Codex SDK leader execution and reply journal recovery',
          'messages without stable source IDs', 'replay beyond dedup retention'] },
      passed: results.filter(item => item.verdict === 'PASS').length, failed: results.filter(item => item.verdict === 'FAIL').length, results };
  }
}
