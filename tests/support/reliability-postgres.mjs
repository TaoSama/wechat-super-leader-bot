import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { localDockerEnvironment } from '../../scripts/verify.mjs';

const DOCKER_TIMEOUT_MS = 60_000;
const READY_TIMEOUT_MS = 60_000;
const READY_INTERVAL_MS = 250;
const IMAGE = 'postgres:16-alpine';

// Register the exact owned name before run: Docker may create the container even
// when its CLI times out, so cleanup must also handle an unknown launch outcome.
export function createReliabilityPostgresFixture({ env, evidence }) {
  const name = 'super-leader-reliability-' + randomUUID();
  const password = randomBytes(24).toString('hex');
  let dockerEnv, attempted = false;
  async function docker(args, { allowFailure = false } = {}) {
    const child = spawn('docker', args, { env: dockerEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timer;
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    try {
      const result = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
        timer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, DOCKER_TIMEOUT_MS);
      });
      if (result.code !== 0 && !allowFailure) throw new Error(`Owned Docker ${args[0]} failed: ${result.signal ?? result.code}: ${stderr.replaceAll(password, '[redacted]')}`);
      return result;
    } finally { clearTimeout(timer); }
  }
  return {
    async start() {
      dockerEnv = localDockerEnvironment({ ...env, POSTGRES_PASSWORD: password });
      attempted = true;
      evidence('database-container-intent', { name, image: IMAGE });
      await docker(['run', '--detach', '--rm', '--name', name, '--label', 'super-leader.fixture=reliability-e2e',
        '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_USER=leader', '-e', 'POSTGRES_DB=leader',
        '-p', '127.0.0.1::5432', IMAGE]);
      const port = (await docker(['port', name, '5432/tcp'])).stdout.trim().split(':').at(-1);
      const deadline = Date.now() + READY_TIMEOUT_MS;
      while (true) {
        const ready = await docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'leader', '-d', 'leader'], { allowFailure: true });
        if (ready.code === 0) break;
        if (![1, 2].includes(ready.code)) throw new Error('Owned PostgreSQL readiness failed: ' + ready.stderr);
        if (Date.now() >= deadline) throw new Error('Owned PostgreSQL readiness timed out');
        await delay(READY_INTERVAL_MS);
      }
      evidence('database-container-ready', { name, port });
      return `postgresql://leader:${password}@127.0.0.1:${port}/leader`;
    },
    async stop() {
      if (!attempted) return;
      const result = await docker(['rm', '--force', name], { allowFailure: true });
      if (result.code !== 0 && !result.stderr.includes('No such container')) throw new Error('Owned PostgreSQL cleanup failed: ' + result.stderr);
      evidence('database-container-removed', { name });
      attempted = false;
    },
  };
}
