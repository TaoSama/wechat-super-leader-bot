import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { readdirSync } from 'node:fs';

export const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const SUITES = ['all', 'unit', 'integration'];
const NODE_MIN_MAJOR = 24;
const TOOL_PROBE_MS = 10_000;
const BUILD_STEP_IDS = new Set(['controller-build', 'gateway-build', 'web-build']);
const POSTGRES_STEP_IDS = new Set([
  'synthetic-integration', 'console-auth-integration', 'wechat-interaction',
  'task-notifications-postgres', 'scheduled-sessions-postgres',
]);
// The JS suites already fan out hundreds of workers; keep their outer pool serial to avoid CPU starvation and timing-sensitive flakes.
const UNIT_PARALLELISM = 1;
const POSTGRES_PARALLELISM = 2;
const LOOPBACK_PARALLELISM = 4;
const ABORT_KILL_GRACE_MS = 1_000;
const INHERITED_ENV = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'CI',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'GOPATH', 'GOCACHE', 'GOMODCACHE', 'GOPROXY', 'GOSUMDB', 'GOTOOLCHAIN',
  'DOCKER_CONFIG', 'DOCKER_HOST', 'DOCKER_CONTEXT',
];

function unitTestFiles(directory = 'tests/unit') {
  return readdirSync(join(PROJECT_ROOT, directory), { withFileTypes: true }).flatMap(entry => {
    const path = `${directory}/${entry.name}`;
    return entry.isDirectory() ? unitTestFiles(path) : entry.isFile() && path.endsWith('.test.mjs') ? [path] : [];
  }).sort();
}

// Keep tool/cache discovery, never inherit application credentials, live-test opt-ins or subprocess hooks.
export function verificationEnvironment(source = process.env) {
  return { ...Object.fromEntries(INHERITED_ENV.filter(key => source[key] !== undefined).map(key => [key, source[key]])),
    SUPER_LEADER_NO_DOTENV: '1',
    GOENV: 'off', GOOS: process.platform === 'darwin' ? 'darwin' : 'linux',
    GOARCH: process.arch === 'arm64' ? 'arm64' : 'amd64', CGO_ENABLED: '1' };
}

export function verificationPlan(suite = 'all', { skipNativeProgress = false } = {}) {
  if (!SUITES.includes(suite)) throw new Error('Unknown suite; use all, unit or integration');
  const step = (id, command, args, cwd = '.', env = {}) => ({ id, command, args, cwd, env });
  const pnpm = (id, component, script) => step(id, 'pnpm', ['--dir', component, 'run', script]);
  const vitest = (id, component) => step(id, 'pnpm', ['--dir', component, 'exec', 'vitest', 'run', '--no-file-parallelism']);
  const builds = [pnpm('controller-build', 'controller', 'build'), pnpm('gateway-build', 'gateway', 'build'),
    pnpm('web-build', 'web', 'build')];
  const unit = [pnpm('controller-typecheck', 'controller', 'typecheck'), vitest('controller-tests', 'controller'),
    builds[0], pnpm('gateway-tests', 'gateway', 'test'), builds[1], vitest('web-tests', 'web'), builds[2],
    step('cli-and-tool-tests', process.execPath, ['--test', ...unitTestFiles()]),
    step('daemon-race', 'go', ['test', '-race', '-count=1', './...'], 'daemon'),
    step('terminal-delivery-sample', 'go', ['run', '-race', './examples/terminal-delivery', '--run'], 'daemon'),
    step('daemon-vet', 'go', ['vet', './...'], 'daemon'),
    step('daemon-build', 'go', ['build', './...'], 'daemon'),
    step('daemon-linux-build', 'go', ['build', './...'], 'daemon', { GOOS: 'linux', GOARCH: 'amd64', CGO_ENABLED: '0' })];
  const integration = [
    step('compose-tests', process.execPath, ['--test', 'tests/integration/deploy/config.test.mjs', 'tests/integration/deploy/gateway.test.mjs',
      'tests/integration/deploy/background-model.test.mjs']),
    step('synthetic-integration', process.execPath, ['tests/integration/run.mjs']),
    step('console-auth-integration', process.execPath, ['tests/integration/console-auth.mjs', '--run']),
    step('wechat-interaction', process.execPath, ['tests/integration/leader/wechat-interaction.mjs', '--run']),
    ...(skipNativeProgress ? [] : [step('native-progress-steering', process.execPath, ['tests/integration/leader/progress-steering.mjs', '--run'])]),
    step('message-latency', process.execPath, ['tests/integration/leader/message-latency.mjs', '--run']),
    step('direct-directory-latency', process.execPath, ['tests/integration/leader/message-latency.mjs', '--run', '--direct-directory']),
    step('direct-console-latency', process.execPath, ['tests/integration/leader/message-latency.mjs', '--run', '--direct-console']),
    step('task-notifications-memory', process.execPath, ['tests/integration/leader/task-notifications.mjs', '--run']),
    step('task-notifications-postgres', process.execPath, ['tests/integration/leader/task-notifications.mjs', '--run', '--postgres']),
    step('scheduled-sessions-memory', process.execPath, ['tests/integration/leader/scheduled-sessions.mjs', '--run']),
    step('scheduled-sessions-postgres', process.execPath, ['tests/integration/leader/scheduled-sessions.mjs', '--run', '--postgres']),
    step('result-gateway-cli', process.execPath, ['tests/integration/leader/result-gateway.mjs', '--run']),
    step('sdk-result-gateway-cli', process.execPath, ['tests/integration/leader/sdk-result-gateway.mjs', '--run']),
    step('background-monitoring', process.execPath, ['tests/integration/leader/background-monitoring.mjs', '--run']),
  ];
  return suite === 'unit' ? unit : suite === 'integration' ? [...builds, ...integration] : [...unit, ...integration];
}

// Resolve the selected Docker context without contacting its daemon. Never start test containers on a remote engine.
export function localDockerEnvironment(env, probe = spawnSync) {
  let host = env.DOCKER_HOST;
  if (env.DOCKER_CONTEXT || !host) {
    const args = ['context', 'inspect', ...(env.DOCKER_CONTEXT ? [env.DOCKER_CONTEXT] : []), '--format', '{{json .Endpoints.docker.Host}}'];
    const result = probe('docker', args, { env, encoding: 'utf8', timeout: TOOL_PROBE_MS });
    if (result.error || result.status !== 0) throw new Error('Cannot resolve Docker context; configure a local Docker engine before integration checks');
    try { host = JSON.parse(result.stdout); }
    catch { throw new Error('Docker context returned an invalid endpoint'); }
  }
  if (typeof host !== 'string' || !/^unix:\/\/\/[^\r\n\0?#]+$/.test(host)) {
    throw new Error('Integration checks require a local Unix Docker socket; remote/TCP contexts are not allowed');
  }
  const { DOCKER_CONTEXT: ignored, ...local } = env;
  return { ...local, DOCKER_HOST: host };
}

export async function runSteps(steps, { env, execute = executeStep, signal, onStep = () => {} }) {
  for (const step of steps) {
    signal?.throwIfAborted();
    onStep(step);
    await execute(step, { ...env, ...step.env });
  }
  signal?.throwIfAborted();
}

export function parallelVerificationPlan(suite = 'all', { skipNativeProgress = false } = {}) {
  if (!SUITES.includes(suite)) throw new Error('Unknown suite; use all, unit or integration');
  const unit = verificationPlan('unit', { skipNativeProgress });
  const integration = verificationPlan('integration', { skipNativeProgress });
  const all = [...unit, ...integration];
  const builds = all.filter(step => BUILD_STEP_IDS.has(step.id)).filter((step, index, steps) =>
    steps.findIndex(candidate => candidate.id === step.id) === index);
  const unitSteps = unit.filter(step => !BUILD_STEP_IDS.has(step.id));
  const integrationSteps = integration.filter(step => !BUILD_STEP_IDS.has(step.id));
  return {
    builds: suite === 'integration' || suite === 'unit' || suite === 'all' ? builds : [],
    unit: suite === 'integration' ? [] : unitSteps,
    integration: suite === 'unit' ? [] : integrationSteps,
  };
}

function spawnStep(step, env, children) {
  const child = spawn(step.command, step.args, {
    cwd: join(PROJECT_ROOT, step.cwd), env: { ...env, ...step.env }, stdio: 'inherit', shell: false,
    detached: process.platform !== 'win32',
  });
  children?.add(child);
  child.once('exit', () => children?.delete(child));
  child.once('error', () => children?.delete(child));
  return child;
}

function executeStep(step, env, { children } = {}) {
  return new Promise((resolveStep, reject) => {
    const child = spawnStep(step, env, children);
    child.once('error', () => reject(new Error(`${step.id}: cannot start required tool`)));
    child.once('exit', (code, signal) => code === 0 ? resolveStep() :
      reject(new Error(`${step.id}: failed (${signal ?? `exit ${code}`})`)));
  });
}

function stopChild(child, signal = 'SIGTERM') {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error.code !== 'ESRCH') return error;
  }
  return undefined;
}

export function formatVerificationError(error, prefix = '') {
  const message = error instanceof Error ? error.message : String(error);
  const lines = [`${prefix}${message}`];
  if (error instanceof AggregateError) {
    for (const nested of error.errors) lines.push(...formatVerificationError(nested, `${prefix}  `));
  }
  return lines;
}

export async function runParallelPool(steps, { env, concurrency, signal, onStep = () => {}, execute = executeStep }) {
  const children = new Set();
  const failures = [];
  let next = 0;
  let killTimer;
  const worker = async () => {
    while (!signal?.aborted) {
      const step = steps[next++];
      if (!step) return;
      onStep(step);
      try { await execute(step, env, { children }); }
      catch (error) { failures.push(error); }
    }
  };
  const abort = () => {
    for (const child of children) {
      const error = stopChild(child);
      if (error) failures.push(new Error(`Failed to stop ${child.pid ?? 'unknown'} verification process`, { cause: error }));
    }
    killTimer = setTimeout(() => {
      for (const child of children) {
        const error = stopChild(child, 'SIGKILL');
        if (error) failures.push(new Error(`Failed to force-stop ${child.pid ?? 'unknown'} verification process`, { cause: error }));
      }
    }, ABORT_KILL_GRACE_MS);
    killTimer.unref?.();
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, steps.length) }, worker));
  } finally {
    signal?.removeEventListener('abort', abort);
    if (killTimer) clearTimeout(killTimer);
    if (signal?.aborted) {
      for (const child of children) {
        const error = stopChild(child, 'SIGKILL');
        if (error) failures.push(new Error(`Failed to force-stop ${child.pid ?? 'unknown'} verification process`, { cause: error }));
      }
    }
  }
  if (failures.length) throw new AggregateError(failures, `${failures.length} parallel verification step(s) failed`);
}

export async function runParallelGroups(plan, { env, signal, onStep = () => {}, execute = executeStep }) {
  await runParallelPool(plan.builds, { env, concurrency: plan.builds.length, signal, onStep, execute });
  const groups = [];
  if (plan.unit.length) groups.push(runParallelPool(plan.unit, { env, concurrency: UNIT_PARALLELISM, signal, onStep, execute }));
  if (plan.integration.length) {
    const postgres = plan.integration.filter(step => POSTGRES_STEP_IDS.has(step.id));
    const loopback = plan.integration.filter(step => !POSTGRES_STEP_IDS.has(step.id));
    if (postgres.length) groups.push(runParallelPool(postgres, { env, concurrency: POSTGRES_PARALLELISM, signal, onStep, execute }));
    if (loopback.length) groups.push(runParallelPool(loopback, { env, concurrency: LOOPBACK_PARALLELISM, signal, onStep, execute }));
  }
  const results = await Promise.allSettled(groups);
  signal?.throwIfAborted();
  const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
  if (failures.length) throw new AggregateError(failures, 'Parallel verification failed');
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    help: { type: 'boolean', short: 'h' }, list: { type: 'boolean' }, parallel: { type: 'boolean' },
    suite: { type: 'string', default: 'all' },
  } });
  if (values.help) {
    console.log('Usage: node scripts/verify.mjs [--suite all|unit|integration] [--parallel] [--list]\nRequires Node >=24, pnpm, Go from daemon/go.mod and installed frozen JS dependencies.\nall/integration also require local Docker and Compose. No dependency install, deployment, real model, WeChat or desktop session tests.\n--parallel runs independent build and verification steps in bounded pools; --list prints commands only, without reading credentials or contacting Docker. Interrupt requests wait for the current check to finish its cleanup.');
    return;
  }
  const skipNativeProgress = process.env.SUPER_LEADER_SKIP_NATIVE_PROGRESS === '1';
  const steps = verificationPlan(values.suite, { skipNativeProgress });
  if (values.list) {
    console.log(JSON.stringify(steps, null, 2));
    return;
  }
  if (skipNativeProgress && values.suite !== 'unit') {
    console.log('[verify] native-progress-steering skipped: this runner cannot provide a working native app-server transport');
  }
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Verification currently supports macOS and Linux');
  if (Number(process.versions.node.split('.')[0]) < NODE_MIN_MAJOR) throw new Error('Verification requires Node >=24');
  let env = verificationEnvironment();
  if (values.suite !== 'unit') env = localDockerEnvironment(env);
  const stop = new AbortController();
  const requestStop = () => {
    if (stop.signal.aborted) return;
    stop.abort(new Error('Verification interrupted after the active check completed'));
    console.error('[verify] Stop requested; waiting for the current check to finish and clean up.');
  };
  process.on('SIGINT', requestStop);
  process.on('SIGTERM', requestStop);
  try {
    const onStep = step => console.log(`[verify] ${step.id}`);
    if (values.parallel) await runParallelGroups(parallelVerificationPlan(values.suite, { skipNativeProgress }), { env, signal: stop.signal, onStep });
    else await runSteps(steps, { env, signal: stop.signal, onStep });
    console.log(`[verify] PASS ${steps.length} checks (${values.suite}); synthetic fixtures only, no production acceptance claimed.`);
  } finally {
    process.removeListener('SIGINT', requestStop);
    process.removeListener('SIGTERM', requestStop);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main().catch(error => { console.error(formatVerificationError(error).join('\n')); process.exitCode = 1; });
}
