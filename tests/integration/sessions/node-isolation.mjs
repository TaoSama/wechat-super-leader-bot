import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

// Invoked by the PostgreSQL integration runner; all nodes and sessions are fixtures.
export async function verifyNodeIsolation({ WebSocket, base, request, nodeTokens, waitFor }) {
  const sessionId = 'same-session-on-two-machines';
  const sockets = new Set();
  const peers = new Map();
  const transportErrors = [];
  const session = { id: sessionId, provider: 'codex-app', title: 'Same title', cwd: '/fixture',
    status: 'idle', loaded: true, capabilities: ['read', 'send'], observedAt: new Date().toISOString() };
  const open = async (nodeId, announcedId = nodeId) => {
    const ws = new WebSocket(`${base.replace('http:', 'ws:')}/v1/daemon`, {
      headers: { authorization: `Bearer ${nodeTokens[nodeId]}` },
    });
    sockets.add(ws);
    const closed = new Promise(resolve => ws.once('close', (...args) => resolve(args)));
    ws.on('error', error => transportErrors.push(error));
    await once(ws, 'open');
    const messages = [];
    ws.on('message', raw => {
      const message = JSON.parse(raw.toString());
      messages.push(message);
      if (message.type === 'command') {
        ws.send(JSON.stringify({ type: 'result', commandId: message.commandId,
          status: message.action === 'send' ? 'accepted' : 'completed',
          ...(message.action === 'send' ? { turnId: `turn-${message.commandId}` } : {}),
          output: `from-${nodeId}` }));
      }
      if (message.type === 'inspect_turn') {
        ws.send(JSON.stringify({ type: 'result', commandId: message.commandId,
          turnId: message.turnId, status: 'completed', output: `recovered-${nodeId}` }));
      }
    });
    ws.send(JSON.stringify({ type: 'hello', version: 1, nodeId: announcedId, sessions: [session], skills: [] }));
    return { ws, closed, messages };
  };
  const close = async peer => {
    peer.ws.close();
    await peer.closed;
    sockets.delete(peer.ws);
  };
  const command = async (nodeId, action = 'send') => {
    const reply = await request('/v1/commands', { nodeId, sessionId, action,
      ...(action === 'send' ? { prompt: `fixture-${nodeId}` } : {}), requestId: randomUUID() });
    assert([200, 202].includes(reply.status), JSON.stringify(reply.body));
    assert(reply.body.commandId);
    await waitFor(async () => (await request(`/v1/commands/${reply.body.commandId}`)).body.status ===
      (action === 'send' ? 'accepted' : 'completed'), 'Fixture command receipt');
    return (await request(`/v1/commands/${reply.body.commandId}`)).body;
  };
  try {
    const [nodeA, nodeB] = Object.keys(nodeTokens);
    const impersonator = await open(nodeA, nodeB);
    assert.equal((await impersonator.closed)[0], 4003, 'Token must bind the announced node identity');
    sockets.delete(impersonator.ws);
    await waitFor(async () => !(await request('/v1/status')).body.nodes.some(n => n.nodeId === nodeA), 'Rejected identity cleanup');
    for (const nodeId of [nodeA, nodeB]) peers.set(nodeId, await open(nodeId));
    await waitFor(async () => (await request('/v1/status')).body.sessions.filter(s => s.id === sessionId).length === 2, 'Two scoped sessions');
    const a = await command(nodeA);
    const b = await command(nodeB);
    assert.notEqual(a.commandId, b.commandId);
    for (const nodeId of [nodeA, nodeB]) {
      const delivered = peers.get(nodeId).messages.filter(m => m.type === 'command');
      assert.equal(delivered.length, 1);
      assert.equal(delivered[0].nodeId, nodeId);
      assert.equal(delivered[0].sessionId, sessionId);
    }
    // A compromised peer knows the exact ID and turn but still cannot complete A's task.
    peers.get(nodeB).ws.send(JSON.stringify({ type: 'result', commandId: a.commandId,
      turnId: a.turnId, status: 'completed', output: 'forged-from-other-node' }));
    await command(nodeB, 'read');
    await delay(100);
    assert.deepEqual((await request(`/v1/commands/${a.commandId}`)).body, a);
    assert(!peers.get(nodeB).messages.some(m => m.type === 'result_ack' && m.commandId === a.commandId));
    await close(peers.get(nodeA));
    await waitFor(async () => (await request(`/v1/commands/${a.commandId}`)).body.status === 'uncertain', 'Only disconnected node becomes uncertain');
    assert.equal((await request(`/v1/commands/${b.commandId}`)).body.status, 'accepted');
    const offline = await request('/v1/commands', { nodeId: nodeA, sessionId, action: 'read', requestId: randomUUID() });
    assert.equal(offline.status, 503);
    assert.equal((await command(nodeB, 'read')).output, `from-${nodeB}`);
    const reconnected = await open(nodeA);
    peers.set(nodeA, reconnected);
    await waitFor(async () => (await request(`/v1/commands/${a.commandId}`)).body.status === 'completed', 'Node-specific readonly reconciliation');
    const recovered = (await request(`/v1/commands/${a.commandId}`)).body;
    assert.equal(recovered.turnId, a.turnId);
    assert.equal(recovered.output, `recovered-${nodeA}`);
    assert.equal(reconnected.messages.filter(m => m.type === 'command').length, 0, 'Reconnect resent a command');
    assert(reconnected.messages.some(m => m.type === 'inspect_turn' && m.commandId === a.commandId));
    assert.equal((await request(`/v1/commands/${b.commandId}`)).body.status, 'accepted');
    assert.equal(transportErrors.length, 0, 'Unexpected fixture WebSocket transport error');
    console.log('PASS two-node isolation: token identity, same session IDs, targeted dispatch, forged receipt rejection, independent disconnect and readonly recovery without resend');
  } finally {
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.CLOSED) continue;
      const closed = once(ws, 'close');
      ws.close();
      await closed;
    }
    await waitFor(async () => !(await request('/v1/status')).body.nodes.some(n => Object.hasOwn(nodeTokens, n.nodeId)), 'Fixture node cleanup');
  }
}
