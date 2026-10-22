import assert from 'node:assert/strict';
import { delay, OBSERVE_MS, TASK_RESULT } from './fixture.mjs';

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
    await h.native.startDaemon();
    await h.waitNode(true);
    const completed = await h.waitCommand(response.body.commandId, 'completed');
    assert.equal(completed.turnId, start.turnId); assert.equal(completed.output, TASK_RESULT);
    await delay(OBSERVE_MS);
    assert.equal(h.native.starts.length, 1, 'Journal recovery started the original task twice');
    h.evidence('assertions', { exactTurnRecovered: start.turnId, dispatches: 1, controllerCrash: true, daemonCrash: true });
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
