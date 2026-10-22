import assert from 'node:assert/strict';
import { delay, OBSERVE_MS, TASK_RESULT } from './fixture.mjs';

const LATER_NATIVE_RESULT = 'SYNTHETIC_LATER_INDEPENDENT_RESULT_DO_NOT_ATTRIBUTE_TO_ORIGINAL';

export const recoveryScenarios = [
  ['controller-claim-before-dispatch', async h => {
    const held = h.control.holdFrame(({ direction, frame }) => direction === 'controller-daemon' && frame.type === 'command');
    const response = await h.submit('合成已持久claim未派发项');
    assert.equal(response.status, 202);
    await h.entered(held.entered, 'Controller claimed before WS dispatch');
    await h.waitCommand(response.body.commandId, 'pending');
    assert.equal(h.native.starts.length, 0);
    await h.control.restart();
    held.release();
    await h.waitNode(true);
    await h.waitCommand(response.body.commandId, 'uncertain');
    await delay(OBSERVE_MS);
    assert.equal(h.native.starts.length, 0, 'Unconfirmed pre-dispatch claim was blindly resent');
    h.evidence('assertions', { persistedBeforeCrash: 'pending', recovered: 'uncertain', nativeStarts: 0,
      resultKnown: false, commandRecordPreserved: true });
  }],
  ['accepted-receipt-loss-controller-daemon-restart', async h => {
    const held = h.control.holdFrame(({ direction, frame }) => direction === 'daemon-controller' && frame.type === 'result' && frame.status === 'accepted');
    const response = await h.submit('合成接收回执丢失恢复项');
    assert.equal(response.status, 202);
    const start = await h.native.waitForStarts(1);
    const accepted = await h.entered(held.entered, 'Daemon persisted accepted receipt');
    assert.equal(accepted.turnId, start.turnId);
    assert.equal((await h.command(response.body.commandId)).status, 'pending');
    await h.native.crashDaemon();
    await h.control.restart();
    held.release();
    h.native.complete(start.turnId, TASK_RESULT);
    const later = h.native.appendExternalCompletedTurn({ prompt: '合成原任务之后的独立任务', output: LATER_NATIVE_RESULT });
    assert.notEqual(later.id, start.turnId);
    assert.equal(h.native.turns.at(-1).id, later.id, 'Independent synthetic turn must be the latest native history');
    assert.equal(h.native.starts.length, 1, 'External synthetic history must not count as a Daemon dispatch');
    await h.native.startDaemon();
    await h.waitNode(true);
    const completed = await h.waitCommand(response.body.commandId, 'completed');
    assert.equal(completed.commandId, response.body.commandId);
    assert.equal(completed.requestId, response.body.requestId);
    assert.equal(completed.nodeId, response.body.nodeId);
    assert.equal(completed.sessionId, h.native.sessionId);
    assert.equal(completed.turnId, start.turnId); assert.equal(completed.output, TASK_RESULT);
    assert.notEqual(completed.output, LATER_NATIVE_RESULT, 'Recovery substituted the latest unrelated native turn');
    await delay(OBSERVE_MS);
    assert.equal(h.native.starts.length, 1, 'Journal recovery started the original task twice');
    h.evidence('assertions', { originalCommandId: completed.commandId, exactTurnRecovered: start.turnId,
      latestIndependentTurn: later.id, nativeHistoryTurns: h.native.turns.length, latestTurnNotUsed: true,
      dispatches: 1, controllerCrash: true, daemonCrash: true });
  }],
  ['native-start-unknown-no-blind-retry', async h => {
    h.native.holdNextStart();
    const response = await h.submit('合成原生写入后ACK未知项');
    assert.equal(response.status, 202);
    const start = await h.native.waitForStarts(1);
    await h.native.crashDaemon();
    await h.control.restart();
    await h.native.startDaemon();
    await h.waitNode(true);
    const uncertain = await h.waitCommand(response.body.commandId, 'uncertain');
    assert.equal(uncertain.turnId, undefined, 'Unacknowledged native write invented a confirmed turn binding');
    await delay(OBSERVE_MS);
    assert.equal(h.native.starts.length, 1, 'Unknown native write was blindly repeated');
    assert.equal(h.native.turns[0].id, start.turnId);
    h.evidence('assertions', { dispatches: 1, recovered: 'uncertain', confirmedTurn: false, noBlindRetry: true });
  }],
];
