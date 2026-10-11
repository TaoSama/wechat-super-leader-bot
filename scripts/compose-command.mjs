import { execFileSync } from 'node:child_process';

const DETECTION_TIMEOUT_MS = 10_000;
const CANDIDATES = [
  { command: 'docker', args: ['compose'] },
  { command: 'docker-compose', args: [] },
];

function detectionFailure(error) {
  if (error?.code === 'ENOENT') return 'not installed';
  if (Number.isInteger(error?.status)) return `exit ${error.status}`;
  if (error?.signal) return 'terminated during detection';
  return 'detection failed';
}

/** Version detection does not start services or connect to a configured Controller. */
export function selectComposeCommand({ execute = execFileSync, env = process.env } = {}) {
  const failures = [];
  for (const candidate of CANDIDATES) {
    try {
      execute(candidate.command, [...candidate.args, 'version'], {
        encoding: 'utf8', env, timeout: DETECTION_TIMEOUT_MS,
        shell: false, stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { command: candidate.command, args: [...candidate.args] };
    } catch (error) {
      // Diagnostics deliberately exclude command output and exception text, which may contain private data.
      failures.push(`${[candidate.command, ...candidate.args].join(' ')}: ${detectionFailure(error)}`);
    }
  }
  throw new Error(`Docker Compose is unavailable (${failures.join('; ')}). Install a Compose plugin or standalone distribution before verification.`);
}

export function execCompose(args, options = {}, execute = execFileSync) {
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) {
    throw new TypeError('Compose arguments must be an array of strings');
  }
  const selected = selectComposeCommand({ execute, env: options.env ?? process.env });
  // Execution failures propagate; never change implementation and replay a failed Compose operation.
  return execute(selected.command, [...selected.args, ...args], { ...options, shell: false });
}
