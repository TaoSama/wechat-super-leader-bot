import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { execCompose } from '../../../scripts/lib/compose-command.mjs';
import { localDockerEnvironment, verificationEnvironment } from '../../../scripts/verify.mjs';
import { withTestCleanup } from '../../support/cleanup.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const IMAGE = 'node:24-bookworm-slim';
const PUBLIC_ORIGIN = 'https://results.fixture.invalid';
const COMPOSE_TIMEOUT_MS = 60_000;
const { values } = parseArgs({ options: { run: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
if (!values.run || values.help) {
  console.log('Usage: node tests/integration/deploy/internal-controller.mjs --run\nRequires built Controller/Gateway and local Docker. Uses synthetic data on an isolated network without external access; never contacts WeChat.');
} else await verify().catch(error => { console.error(error); process.exitCode = 1; });

async function verify() {
  const env = localDockerEnvironment({ ...verificationEnvironment(), COMPOSE_DISABLE_ENV_FILE: 'true',
    POSTGRES_PASSWORD: 'synthetic-password', CONTROLLER_TOKEN: 'synthetic-internal-transport-token', NODE_TOKENS: '{}',
    CONTROLLER_IMAGE: 'synthetic-controller:release', GATEWAY_IMAGE: 'synthetic-gateway:release',
    CONTROLLER_URL: 'https://unreachable-public.fixture.invalid',
    CONSOLE_PUBLIC_URL: PUBLIC_ORIGIN, RESULT_PUBLIC_ORIGIN: PUBLIC_ORIGIN });
  const rendered = JSON.parse(execCompose(['--project-directory', ROOT, '--env-file', '/dev/null', '--profile', 'wechat',
    ...['compose.yaml', 'deploy/compose.production.yaml', 'deploy/compose.gateway.yaml', 'deploy/compose.release.yaml']
      .flatMap(path => ['-f', join(ROOT, path)]), 'config', '--format', 'json'],
  { env, encoding: 'utf8', timeout: COMPOSE_TIMEOUT_MS }));
  assert.equal(rendered.services.gateway.environment.CONTROLLER_URL, 'http://controller:8790');
  assert.equal(rendered.services.gateway.environment.RESULT_PUBLIC_ORIGIN, PUBLIC_ORIGIN);
  const dir = await mkdtemp(join(tmpdir(), 'internal-controller-'));
  const configPath = join(dir, 'compose.json'), project = `internal-controller-${randomUUID()}`;
  const compose = args => execCompose(['--project-name', project, '--project-directory', ROOT, '--env-file', '/dev/null',
    '-f', configPath, ...args], { env, encoding: 'utf8', timeout: COMPOSE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
  let attempted = false;
  await withTestCleanup(async () => {
    // No production images, credentials, mounts or volumes enter the fixture.
    // Only transport-related environment is copied from the real merged configuration.
    const services = {};
    for (const [service, mode] of [['controller', 'serve'], ['gateway', 'probe']]) {
      const source = rendered.services[service].environment;
      const keys = ['CONTROLLER_TOKEN', 'CONTROLLER_URL', 'ALLOW_INSECURE_CONTROLLER', 'CONSOLE_PUBLIC_URL', 'RESULT_PUBLIC_ORIGIN'];
      services[service] = { image: IMAGE, pull_policy: 'never', working_dir: '/workspace', read_only: true,
        entrypoint: ['node', 'tests/support/internal-controller-probe.mjs', '--mode', mode],
        environment: { SUPER_LEADER_NO_DOTENV: '1',
          ...Object.fromEntries(keys.filter(key => source[key] !== undefined).map(key => [key, source[key]])) },
        volumes: [{ type: 'bind', source: ROOT, target: '/workspace', read_only: true }], tmpfs: ['/tmp'],
        networks: ['fixture'] };
    }
    services.controller.healthcheck = { test: ['CMD', 'node', '-e',
      "fetch('http://127.0.0.1:8790/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],
    interval: '1s', timeout: '2s', retries: 15 };
    await writeFile(configPath, JSON.stringify({ services, networks: { fixture: { internal: true } } }), { mode: 0o600 });
    try { execFileSync('docker', ['image', 'inspect', IMAGE], { env, stdio: 'pipe', timeout: 10_000 }); }
    catch (error) {
      if (error.status !== 1) throw error;
      execFileSync('docker', ['pull', IMAGE], { env, stdio: 'pipe', timeout: COMPOSE_TIMEOUT_MS });
    }
    attempted = true;
    compose(['up', '--detach', '--wait', '--wait-timeout', '30', 'controller']);
    const output = compose(['run', '--rm', '--no-deps', 'gateway']);
    console.log(output.trim());
    console.log('PASS merged production transport on isolated Docker network; no public DNS/Nginx route, no WeChat requests');
  }, [
    { label: 'owned Compose project', cleanup: () => { if (attempted) compose(['down', '--remove-orphans', '--timeout', '5']); } },
    { label: 'isolated configuration', cleanup: () => rm(dir, { recursive: true, force: true }) },
  ]);
}
