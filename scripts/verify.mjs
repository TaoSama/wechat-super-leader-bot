import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { readdirSync } from 'node:fs';

export const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const SUITES = ['all', 'unit', 'integration'];
const NODE_MIN_MAJOR = 24;
const TOOL_PROBE_MS = 10_000;
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

export function verificationPlan(suite = 'all') {
  if (!SUITES.includes(suite)) throw new Error('Unknown suite; use all, unit or integration');
  const step = (id, command, args, cwd = '.', env = {}) => ({ id, command, args, cwd, env });
  const pnpm = (id, component, script) => step(id, 'pnpm', ['--dir', component, 'run', script]);
  const builds = [pnpm('controller-build', 'controller', 'build'), pnpm('gateway-build', 'gateway', 'build'),
    pnpm('web-build', 'web', 'build')];
  const unit = [pnpm('controller-typecheck', 'controller', 'typecheck'), pnpm('controller-tests', 'controller', 'test'),
    builds[0], pnpm('gateway-tests', 'gateway', 'test'), builds[1], pnpm('web-tests', 'web', 'test'), builds[2],
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
    step('native-progress-steering', process.execPath, ['tests/integration/leader/progress-steering.mjs', '--run']),
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

function executeStep(step, env) {
  return new Promise((resolveStep, reject) => {
    const child = spawn(step.command, step.args, {
      cwd: join(PROJECT_ROOT, step.cwd), env, stdio: 'inherit', shell: false, detached: process.platform !== 'win32',
    });
    child.once('error', () => reject(new Error(`${step.id}: cannot start required tool`)));
    child.once('exit', (code, signal) => code === 0 ? resolveStep() :
      reject(new Error(`${step.id}: failed (${signal ?? `exit ${code}`})`)));
  });
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    help: { type: 'boolean', short: 'h' }, list: { type: 'boolean' }, suite: { type: 'string', default: 'all' },
  } });
  if (values.help) {
    console.log('Usage: node scripts/verify.mjs [--suite all|unit|integration] [--list]\nRequires Node >=24, pnpm, Go from daemon/go.mod and installed frozen JS dependencies.\nall/integration also require local Docker and Compose. No dependency install, deployment, real model, WeChat or desktop session tests.\n--list prints commands only, without reading credentials or contacting Docker. Interrupt requests wait for the current check to finish its cleanup.');
    return;
  }
  const steps = verificationPlan(values.suite);
  if (values.list) {
    console.log(JSON.stringify(steps, null, 2));
    return;
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
    await runSteps(steps, { env, signal: stop.signal, onStep: step => console.log(`[verify] ${step.id}`) });
    console.log(`[verify] PASS ${steps.length} checks (${values.suite}); synthetic fixtures only, no production acceptance claimed.`);
  } finally {
    process.removeListener('SIGINT', requestStop);
    process.removeListener('SIGTERM', requestStop);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
