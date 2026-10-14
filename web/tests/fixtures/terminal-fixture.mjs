import { createHash, randomUUID } from 'node:crypto';

export const TERMINAL_MODES = ['ready', 'disabled', 'expired', 'uncertain'];
const SESSION_ID = 'terminal:' + Buffer.alloc(32, 7).toString('base64url');
const READY_DURATION_MS = 45_000;

// Browser-only synthetic API state, with no network/terminal implementation.
export function createTerminalFixture(sessions, commands) {
  let mode = 'disabled', writes = 0;
  const session = { id: SESSION_ID, nodeId: 'demoair', provider: 'terminal/codex',
    title: '终端投递验收 · 仅合成输入', cwd: '/synthetic/terminal', status: 'idle',
    loaded: false, capabilities: ['read'], observedAt: new Date().toISOString() };
  function setMode(next) {
    if (!TERMINAL_MODES.includes(next)) throw new Error('Unknown terminal fixture mode');
    mode = next;
    if (!sessions.includes(session)) sessions.push(session);
    session.observedAt = new Date().toISOString();
    if (mode === 'disabled') { delete session.sendAvailability; return; }
    const time = Date.now() - (mode === 'expired' ? READY_DURATION_MS * 2 : 0);
    session.sendAvailability = { route: 'terminal-pane', mode: 'non-atomic', state: 'ready',
      observedAt: new Date(time).toISOString(), validUntil: new Date(time + READY_DURATION_MS).toISOString() };
  }
  return {
    setMode, matches(node, id) { return node === session.nodeId && id === SESSION_ID; },
    metrics() { return { mode, terminalInputWrites: writes }; },
    send(body) {
      const existing = commands.find(command => command.requestId === body.requestId);
      if (existing) return existing.sessionId === SESSION_ID && existing.prompt === body.prompt
        ? { code: 200, body: existing } : { code: 409, body: { error: 'Synthetic request ID conflict' } };
      if (!['ready', 'uncertain'].includes(mode) || Date.parse(session.sendAvailability.validUntil) <= Date.now()) {
        return { code: 409, body: { error: 'Synthetic terminal is read-only or expired' } };
      }
      if (typeof body.prompt !== 'string' || !body.prompt.trim() || typeof body.requestId !== 'string' || !body.requestId) {
        return { code: 400, body: { error: 'Invalid synthetic input' } };
      }
      writes++;
      const now = new Date().toISOString();
      const command = { commandId: 'cmd_' + randomUUID(), requestId: body.requestId,
        nodeId: session.nodeId, sessionId: SESSION_ID, action: 'send', prompt: body.prompt,
        sendRoute: 'terminal-pane', status: mode === 'uncertain' ? 'uncertain' : 'input-written', output: '',
        createdAt: now, updatedAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString(),
        ...(mode === 'uncertain' ? { error: '合成终端回执丢失，执行未确认；请勿重发。' } : { inputReceipt: {
          kind: 'terminal-input-written', sessionId: SESSION_ID, requestId: randomUUID(),
          promptSHA256: createHash('sha256').update(body.prompt).digest('hex'), responseRevision: writes, observedRevision: writes,
        } }),
      };
      commands.unshift(command);
      return { code: 200, body: command };
    },
  };
}
