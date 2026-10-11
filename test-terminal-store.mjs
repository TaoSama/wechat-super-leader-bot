import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// Real two-client PG transactions, distinct from the public HTTP/Go runtime path.
export async function verifyTerminalStore({ stores }) {
  const now = new Date().toISOString();
  const sessionId = 'terminal:' + Buffer.alloc(32, 3).toString('base64url');
  const command = { commandId: 'terminal-proof-race', requestId: 'terminal-proof-race', nodeId: 'terminal-proof-node',
    sessionId, action: 'send', prompt: 'synthetic input only', sendRoute: 'terminal-pane', status: 'pending',
    createdAt: now, updatedAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const proof = { kind: 'terminal-input-written', sessionId, requestId: randomUUID(), promptSHA256: 'a'.repeat(64),
    responseRevision: 7, observedRevision: 8 };
  await stores[0].createCommandIfAbsent(command);
  const pending = await stores[1].getCommand(command.commandId);
  for (const [status, turnId, inputReceipt, output] of [
    ['accepted', 'invented-turn', undefined, ''], ['completed', 'invented-turn', undefined, ''],
    ['input-written', undefined, undefined, ''], ['input-written', undefined, { ...proof, sessionId: sessionId + 'x' }, ''],
    ['input-written', undefined, { ...proof, observedRevision: 6 }, ''],
    ['input-written', undefined, { ...proof, observedRevision: Number.MAX_SAFE_INTEGER + 1 }, ''],
    ['input-written', undefined, { ...proof, requestId: 'arbitrary-http-request' }, ''],
    ['input-written', undefined, { ...proof, endpoint: '/private/socket' }, ''],
    ['input-written', undefined, proof, 'invented task output'], ['uncertain', undefined, proof, ''],
  ]) {
    await assert.rejects(stores[1].updateCommandStatus(command.commandId, status, output, undefined, turnId, inputReceipt));
    assert.deepEqual(await stores[0].getCommand(command.commandId), pending, 'Rejected proof changed PostgreSQL record');
  }
  const proposals = [proof, { ...proof, requestId: randomUUID() }];
  const settled = await Promise.allSettled(stores.map((store, index) =>
    store.updateCommandStatus(command.commandId, 'input-written', '', undefined, undefined, proposals[index])));
  assert.equal(settled.filter(result => result.status === 'fulfilled').length, 1, 'Concurrent input proofs both bound');
  const recorded = await stores[0].getCommand(command.commandId);
  assert.equal(recorded.status, 'input-written'); assert.equal(recorded.turnId, undefined);
  assert.deepEqual(recorded.inputReceipt, proposals[settled.findIndex(result => result.status === 'fulfilled')]);
  await stores[1].updateCommandStatus(command.commandId, 'input-written', '', undefined, undefined, recorded.inputReceipt);
  assert.deepEqual(await stores[0].getCommand(command.commandId), recorded, 'Identical proof changed immutable receipt');
  for (const status of ['pending', 'accepted', 'completed', 'failed', 'uncertain']) {
    await assert.rejects(stores[1].updateCommandStatus(command.commandId, status, '', undefined,
      ['accepted', 'completed'].includes(status) ? 'fake-turn' : undefined));
  }
  await stores[1].markNodeActiveCommandsUncertain(command.nodeId, 'synthetic disconnect');
  await stores[0].markExpiredActiveCommandsUncertain();
  assert.deepEqual(await stores[1].getCommand(command.commandId), recorded, 'Disconnect or TTL downgraded delivery proof');
  assert.deepEqual(await stores[0].listInspectableCommands(command.nodeId), [], 'Terminal input entered native turn reconciliation');
  for (const action of ['read', 'send']) {
    const native = { ...command, commandId: 'native-reject-' + action, requestId: 'native-reject-' + action,
      sessionId: 'native-session', action, sendRoute: action === 'send' ? 'control-socket' : undefined };
    await stores[0].createCommandIfAbsent(native);
    await assert.rejects(stores[1].updateCommandStatus(native.commandId, 'input-written', '', undefined, undefined, proof));
    assert.equal((await stores[0].getCommand(native.commandId)).status, 'pending');
  }
  console.log('PASS real PostgreSQL terminal proof CAS: one immutable winner; invalid/native/read receipts roll back; disconnect/TTL cannot downgrade; no native inspection');
}
