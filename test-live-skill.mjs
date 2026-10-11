import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { help: { type: 'boolean', short: 'h' }, run: { type: 'boolean' } } });
if (values.help) {
  console.log('Usage: node test-live-skill.mjs --run\nCreates one new Codex test thread on the existing local socket using gpt-6.1-sol. Dispatches a fixed read-only ai-scaffold-init verification through the local Controller. Never sends WeChat messages or resumes existing threads.');
} else if (!values.run) {
  console.error('Explicit --run required: this creates and uses a new test thread.');
  process.exitCode = 1;
} else {
  await main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

async function main() {
  const require = createRequire(new URL('./controller/package.json', import.meta.url));
  const { WebSocket } = require('ws');
  const root = fileURLToPath(new URL('./', import.meta.url));
  let config;
  try { config = JSON.parse(await readFile(new URL('./.runtime/local.json', import.meta.url), 'utf8')); }
  catch { throw new Error('Unable to read private local configuration'); }
  const http = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:8790${path}`, {
      method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${config.controllerToken}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(10000),
    });
    assert(response.ok, `Controller HTTP ${response.status}`);
    return response.json();
  };
  const before = await http('/v1/status');
  const skill = before.skills.find(item => item.nodeId === config.nodeId && item.name === 'ai-scaffold-init');
  assert(skill, 'Required installed skill not found');
  const socketPath = join(homedir(), '.codex/app-server-control/app-server-control.sock');
  const ws = new WebSocket('ws://localhost/', { createConnection: () => createConnection(socketPath), handshakeTimeout: 10000 });
  const pending = new Map();
  const transportErrors = [];
  let sequence = 0;
  ws.on('error', error => transportErrors.push(error));
  ws.on('message', raw => {
    let message;
    try { message = JSON.parse(raw.toString()); }
    catch {
      transportErrors.push(new Error('Invalid Codex RPC JSON'));
      ws.close();
      return;
    }
    if (message.method || !pending.has(message.id)) return;
    const entry = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(`Codex RPC error ${message.error.code}: ${message.error.message}`));
    else entry.resolve(message.result);
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
  try {
    await once(ws, 'open');
    await rpc('initialize', { clientInfo: { name: 'super-leader-skill-test', version: '1.0.0' } });
    ws.send(JSON.stringify({ method: 'initialized', params: {} }));
    const started = await rpc('thread/start', { cwd: root, model: 'gpt-6.1-sol', approvalPolicy: 'never', sandbox: 'read-only' });
    const sessionId = started.thread.id;
    console.log(JSON.stringify({ check: 'new-test-thread', sessionId }));
    await rpc('thread/name/set', { threadId: sessionId, name: 'Super Leader Skill 只读验收' });
    await until(async () => (await http('/v1/status')).sessions.some(s => s.nodeId === config.nodeId && s.id === sessionId && s.status === 'idle' && s.capabilities.includes('send')), 30000, 'New thread discovery');
    const marker = `SL_SKILL_${randomUUID()}`;
    const command = await http('/v1/commands', { nodeId: config.nodeId, sessionId, action: 'send', requestId: randomUUID(),
      skills: [{ id: skill.id, digest: skill.digest }],
      prompt: `仅做只读验收：完整读取选定技能并实际计算文件 SHA256，然后按其 Verify 中的符号链接要求检查当前项目 CLAUDE.md、AGENTS.md、.codex/skills、.trae/skills 的实际目标。这是已有非空项目，禁止初始化、修改或创建任何文件、备份、后台进程或发送外部消息，不运行测试或联网。禁止读取 .runtime、.env、账号凭证、配置或其他任务的会话。只允许读取选定 Skill 和执行 pwd、ls、readlink、shasum 等只读检查，不使用重定向、管道、变量或命令替换。最后报告实测摘要、四个链接及 ${marker}。不要把已有文档非空当成需要修复。` });
    assert(command.commandId);
    console.log(JSON.stringify({ check: 'dispatch', commandId: command.commandId, sessionId }));
    let result;
    await until(async () => {
      result = await http(`/v1/commands/${command.commandId}`);
      return ['completed', 'failed', 'uncertain'].includes(result.status);
    }, 180000, 'Skill turn completion');
    assert.equal(result.status, 'completed');
    assert.equal(result.nodeId, config.nodeId);
    assert.equal(result.sessionId, sessionId);
    assert.deepEqual(result.skills, [{ id: skill.id, digest: skill.digest }]);
    assert(result.turnId && result.output.includes(marker));
    assert(result.output.includes(skill.digest), 'Final output missing verified skill digest');
    const read = await rpc('thread/read', { threadId: sessionId, includeTurns: true });
    const turn = read.thread.turns.find(item => item.id === result.turnId);
    assert(turn && turn.status === 'completed');
    const agentText = turn.items.filter(item => item.type === 'agentMessage').map(item => item.text ?? '').join('\n');
    assert(agentText.includes(marker), 'Native turn agent output missing marker');
    assert(agentText.includes(skill.digest), 'Native turn agent output missing digest');
    const commands = turn.items.filter(item => item.type === 'commandExecution');
    assert(commands.every(item => item.status === 'completed' && item.exitCode === 0), 'A verification command failed');
    for (const item of commands) {
      const shell = item.command.match(/^\/bin\/(?:zsh|bash) -lc '([^']*)'$/)?.[1] ?? item.command;
      assert(!/[><|&$`\n\r]/u.test(shell), 'Unsupported shell syntax in read-only fixture');
      assert(!/\.runtime|\.env|credentials|config\.toml/.test(shell), 'Sensitive path accessed by fixture');
      assert(shell.split(';').filter(part => part.trim()).every(part =>
        /^(?:\/bin\/)?(?:pwd|ls|readlink|shasum|sha256sum|cat)(?:\s|$)/.test(part.trim())), 'Unexpected fixture command');
    }
    assert(commands.some(item => item.command.includes('SKILL.md')), 'No skill file read tool evidence');
    assert(commands.some(item => /readlink|ls/.test(item.command)), 'No filesystem verification evidence');
    assert(commands.some(item => /shasum|sha256sum/.test(item.command) && (item.aggregatedOutput ?? '').includes(skill.digest)), 'No computed digest tool evidence');
    for (const link of ['CLAUDE.md', 'AGENTS.md', '.codex/skills', '.trae/skills']) {
      assert(commands.some(item => item.command.includes(link) && (item.aggregatedOutput ?? '').includes(link)), `Missing link evidence: ${link}`);
    }
    assert(!turn.items.some(item => item.type === 'fileChange'), 'Unexpected file edit');
    assert.equal(transportErrors.length, 0);
    console.log(JSON.stringify({ outcome: 'PASS', sessionId, commandId: result.commandId, turnId: result.turnId,
      skill: skill.name, digest: skill.digest, toolCommands: commands.length, outputChars: result.output.length }));
  } finally {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Test connection closed')); }
    pending.clear();
    if (ws.readyState !== WebSocket.CLOSED) { const closed = once(ws, 'close'); ws.close(); await closed; }
  }
}

async function until(predicate, timeout, label) {
  const deadline = Date.now() + timeout;
  do { if (await predicate()) return; await delay(1000); } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}; do not replay this task without inspecting its original turn`);
}
