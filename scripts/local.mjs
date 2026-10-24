import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { localDockerEnvironment } from './verify.mjs';
import { loadSendEligibility } from './lib/send-eligibility.mjs';
import { selectComposeCommand } from './lib/compose-command.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const runtime = fileURLToPath(new URL('../.runtime/', import.meta.url));
const configPath = fileURLToPath(new URL('../.runtime/local.json', import.meta.url));
const modes = ['init', 'up', 'down', 'daemon', 'gateway', 'check', 'sessions'];
const parseCli = () => parseArgs({ options: {
  help: { type: 'boolean', short: 'h' },
  ...Object.fromEntries(modes.map(mode => [mode, { type: 'boolean' }])),
  compose: { type: 'string' },
  'simulation-chat': { type: 'string' },
  controller: { type: 'string' },
} });

function isLoopback(hostname) {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

export function resolveControllerUrls(rawUrl = 'http://127.0.0.1:8790') {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw new Error('Invalid controller URL; must be a non-empty string');
  }
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Invalid controller URL; must be a valid URL string');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Controller URL must not contain user credentials (userinfo)');
  }
  if (rawUrl.includes('?') || parsed.search) {
    throw new Error('Controller URL must not contain query parameters');
  }
  if (rawUrl.includes('#') || parsed.hash) {
    throw new Error('Controller URL must not contain URL fragments');
  }
  const hostname = parsed.hostname.toLowerCase();
  const loopback = isLoopback(hostname);
  const path = parsed.pathname.replace(/\/+$/, '');
  if (parsed.protocol === 'https:') {
    const httpUrl = `${parsed.origin}${path}`;
    const wsUrl = `wss://${parsed.host}${path}/v1/daemon`;
    return { httpUrl, wsUrl, isRemote: !loopback };
  }
  if (parsed.protocol === 'http:') {
    if (!loopback) {
      throw new Error('Remote controller URL requires https:// (plain http:// is only allowed for loopback)');
    }
    const httpUrl = `${parsed.origin}${path}`;
    const wsUrl = `ws://${parsed.host}${path}/v1/daemon`;
    return { httpUrl, wsUrl, isRemote: false };
  }
  throw new Error(`Unsupported protocol "${parsed.protocol}" in controller URL; expected https: or loopback http:`);
}

const isDirectRun = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  const { values } = parseCli();
  if (values.help) {
    console.log(`Usage: node scripts/local.mjs --init|--up|--down|--daemon|--gateway|--check|--sessions [--controller URL] [--compose PATH]\nPrivate config: ${configPath}\n--init generates private credentials once; existing config is never overwritten.\n--up starts Docker Controller/Web/PostgreSQL locally. --down stops local Docker containers.\n--compose PATH overrides Compose executable; otherwise the Docker Compose plugin or standalone executable is detected.\n--controller URL overrides Controller target (env CONTROLLER_URL; remote requires HTTPS).\n--daemon runs native daemon in foreground.\n--gateway explicitly starts real WeChat polling; allowedChatIds must first be configured.\n--check checks Controller health/auth without printing credentials or conversation content.\n--sessions lists session titles, IDs and capabilities only; never sends a task.`);
    console.log('--simulation-chat synthetic-ID: temporarily allow a synthetic chat for --up only; does not change private config or start WeChat.');
  } else {
    await main(values).catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}

async function main(values) {
  const selected = modes.filter(mode => values[mode]);
  if (selected.length !== 1) throw new Error('Choose exactly one mode; see --help');
  const mode = selected[0];
  const simulationChat = values['simulation-chat'];
  if (simulationChat !== undefined && (mode !== 'up' || !/^synthetic-[a-zA-Z0-9_-]+$/.test(simulationChat))) {
    throw new Error('--simulation-chat requires --up and a synthetic- prefixed test ID');
  }
  const targetControllerRaw = values.controller ?? process.env.CONTROLLER_URL ?? 'http://127.0.0.1:8790';
  const targetUrls = resolveControllerUrls(targetControllerRaw);
  if (values.controller !== undefined && (mode === 'up' || mode === 'down')) {
    throw new Error('--controller is not allowed with --up or --down; local lifecycle manages local Docker containers only.');
  }
  if (targetUrls.isRemote && (mode === 'up' || mode === 'down')) {
    throw new Error('CONTROLLER_URL points to a remote controller; --up and --down only manage local Docker containers. Clear CONTROLLER_URL or remove --controller before running local container lifecycle.');
  }
  if (mode === 'init') {
    await mkdir(runtime, { recursive: true, mode: 0o700 });
    const secret = () => randomBytes(32).toString('hex');
    const config = { nodeId: 'demoair', postgresPassword: secret(), controllerToken: secret(), nodeToken: secret(), allowedChatIds: [] };
    try { await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      console.log('Private configuration already exists; left unchanged.');
      return;
    }
    console.log(`Private configuration created (0600): ${configPath}\nNo WeChat polling started; chat allowlist is empty.`);
    return;
  }
  const metadata = await stat(configPath);
  if ((metadata.mode & 0o077) !== 0) throw new Error('Private configuration must not be accessible by group or others (expected 0600).');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  for (const field of ['postgresPassword', 'controllerToken', 'nodeToken']) {
    if (typeof config[field] !== 'string' || !/^[a-f0-9]{64}$/.test(config[field])) throw new Error(`Invalid private configuration field: ${field}`);
  }
  if (typeof config.nodeId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(config.nodeId)) throw new Error('Invalid nodeId');
  if (!Array.isArray(config.allowedChatIds) || config.allowedChatIds.some(id => typeof id !== 'string' || !id.trim() || id.includes(','))) throw new Error('allowedChatIds must be an array of nonempty chat IDs');
  const env = {
    ...process.env,
    POSTGRES_PASSWORD: config.postgresPassword,
    CONTROLLER_TOKEN: config.controllerToken,
    NODE_TOKENS: JSON.stringify({ [config.nodeId]: config.nodeToken }),
    ALLOWED_CHAT_IDS: [...config.allowedChatIds, ...(simulationChat ? [simulationChat] : [])].join(','),
    CONTROLLER_DB_VOLUME: config.databaseVolume ?? 'super-leader-controller-db',
  };
  if (mode === 'check' || mode === 'sessions') {
    const response = await fetch(`${targetUrls.httpUrl}/v1/status`, {
      headers: { authorization: `Bearer ${config.controllerToken}` }, signal: AbortSignal.timeout(5000), redirect: 'error',
    });
    if (!response.ok) throw new Error(`Controller check failed: HTTP ${response.status}`);
    const data = await response.json();
    const { selectSendRoute } = await loadSendEligibility();
    const now = Date.now();
    const canSendNow = session => data.nodes.some(node => node.nodeId === session.nodeId && node.connected)
      && selectSendRoute(session, now).ready;
    if (mode === 'sessions') {
      console.log(JSON.stringify({ sessions: data.sessions.map(session => ({
        nodeId: session.nodeId, sessionId: session.id, title: session.title,
        provider: session.provider, status: session.status, capabilities: session.capabilities,
        observedAt: session.observedAt,
        canSendNow: canSendNow(session),
      })) }, null, 2));
      return;
    }
    console.log(JSON.stringify({ leaderMode: data.leaderMode ?? 'unknown', nodes: data.nodes,
      sessionCount: data.sessions.length, sendCapableSessionCount: data.sessions.filter(canSendNow).length,
      skillCount: data.skills?.length ?? 0, commandCount: data.commands.length }, null, 2));
    return;
  }
  if (mode === 'up' || mode === 'down') {
    const localEnv = localDockerEnvironment(env);
    const selected = values.compose === undefined
      ? selectComposeCommand({ env: localEnv })
      : { command: values.compose, args: [] };
    if (!selected.command.trim()) throw new Error('--compose must be a non-empty executable path');
    await run(selected.command, [...selected.args, '-f', `${root}compose.yaml`, ...(mode === 'up' ? ['up', '-d', '--build'] : ['down'])], localEnv);
  } else if (mode === 'daemon') {
    await run(`${root}daemon/bin/super-leader-daemon`, [], {
      ...env, NODE_ID: config.nodeId, NODE_TOKEN: config.nodeToken, CONTROLLER_WS_URL: targetUrls.wsUrl,
      DAEMON_STATE_DIR: process.env.DAEMON_STATE_DIR ?? `${runtime}daemon-state`,
      SKILL_ROOTS: process.env.SKILL_ROOTS ?? JSON.stringify(await installedSkillRoots()),
    });
  } else if (mode === 'gateway') {
    if (!config.allowedChatIds.length) throw new Error('Configure allowedChatIds in private local.json and authorize the same IDs on the target Controller before enabling real WeChat polling.');
    await run(process.execPath, [`${root}gateway/dist/index.js`, '--run'], {
      ...env, CONTROLLER_URL: targetUrls.httpUrl, WECHAT_STATE_PATH: `${runtime}wechat-gateway-state.json`,
    });
  }
}

async function installedSkillRoots() {
  const roots = [];
  for (const directory of [join(homedir(), '.claude/skills'), join(homedir(), '.agents/skills')]) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    roots.push(directory);
    // Direct installed aliases are explicit roots. Deeper symlinks remain bounded by the daemon.
    for (const entry of entries) if (entry.isSymbolicLink()) roots.push(join(directory, entry.name));
  }
  return roots;
}

async function run(command, args, env) {
  const child = spawn(command, args, { cwd: root, env, stdio: 'inherit' });
  const forward = signal => { if (child.exitCode === null && child.signalCode === null) child.kill(signal); };
  const interrupt = () => forward('SIGINT');
  const terminate = () => forward('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    const [code, signal] = await once(child, 'exit');
    if (code !== 0 && !['SIGINT', 'SIGTERM'].includes(signal)) throw new Error(`${command} exited with status ${code ?? signal}`);
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}
