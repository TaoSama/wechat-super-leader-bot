import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { stopTestProcess } from './cleanup.mjs';
import { localDockerEnvironment } from '../../scripts/verify.mjs';

const POSTGRES_IMAGE = 'postgres:16-alpine';
const DOCKER_TIMEOUT_MS = 30_000;
const READINESS_TIMEOUT_MS = 25_000;
const POLL_INTERVAL_MS = 100;
const HEALTH_TIMEOUT_MS = 1_000;
const REQUEST_TIMEOUT_MS = 5_000;
const LOG_LIMIT = 50;

export async function waitFor(predicate, label) {
  const deadline = Date.now() + READINESS_TIMEOUT_MS;
  do { if (await predicate()) return; await delay(POLL_INTERVAL_MS); } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}

export function createPostgresFixture({ env = process.env } = {}) {
  const password = randomBytes(24).toString('hex');
  const name = `super-leader-test-${randomUUID()}`;
  let containerCreated = false;
  let dockerEnv;
  const docker = args => execFileSync('docker', args, {
    encoding: 'utf8', env: dockerEnv, timeout: DOCKER_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  return {
    password,
    async start() {
      dockerEnv = localDockerEnvironment({ ...env, POSTGRES_PASSWORD: password });
      docker(['run', '--detach', '--rm', '--name', name, '-e', 'POSTGRES_PASSWORD',
        '-e', 'POSTGRES_USER=leader', '-e', 'POSTGRES_DB=leader', '-p', '127.0.0.1::5432', POSTGRES_IMAGE]);
      containerCreated = true;
      const port = docker(['port', name, '5432/tcp']).split(':').at(-1);
      await waitFor(async () => {
        try { docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'leader', '-d', 'leader']); return true; }
        catch (error) { if (error.status === 1 || error.status === 2) return false; throw error; }
      }, 'PostgreSQL readiness');
      return `postgresql://leader:${password}@127.0.0.1:${port}/leader`;
    },
    stop() {
      if (!containerCreated) return;
      docker(['stop', '--time', '5', name]);
      containerCreated = false;
    },
  };
}

export async function createControllerFixture({ env, secrets = [], logs = [] }) {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  const base = `http://127.0.0.1:${port}`;
  const controllerEnv = { ...process.env, ...env, HOST: '127.0.0.1', PORT: String(port), CONSOLE_PUBLIC_URL: base };
  let child;
  const appendLog = chunk => {
    let text = chunk.toString();
    for (const secret of secrets) text = text.replaceAll(secret, '[redacted]');
    logs.push(text);
    if (logs.length > LOG_LIMIT) logs.shift();
  };
  return {
    base, port, env: controllerEnv,
    async start() {
      child = spawn(process.execPath, ['dist/index.js'], {
        cwd: fileURLToPath(new URL('../../controller/', import.meta.url)),
        env: controllerEnv, stdio: ['ignore', 'pipe', 'pipe'],
      });
      for (const stream of [child.stdout, child.stderr]) stream.on('data', appendLog);
      let spawnError;
      child.on('error', error => { spawnError = error; });
      await waitFor(async () => {
        if (spawnError) throw spawnError;
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Controller exited: ${logs.join('')}`);
        try { return (await fetch(`${base}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })).ok; }
        catch (error) { if (error instanceof TypeError || error.name === 'TimeoutError') return false; throw error; }
      }, 'Controller readiness');
    },
    async stop() {
      await stopTestProcess(child);
      child = undefined;
    },
    async request(path, body, authenticated = true) {
      const response = await fetch(`${base}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: `Bearer ${controllerEnv.CONTROLLER_TOKEN}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}
