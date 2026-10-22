import assert from 'node:assert/strict';
import { delay, OBSERVE_MS, TASK_RESULT } from './fixture.mjs';

export const queueScenarios = [
  ['busy-native-admission', async h => {
    const queued = [];
    h.native.setStatus('busy');
    await h.waitSession('active');
    for (const prompt of ['合成忙时新增任务-1', '合成忙时新增任务-2']) queued.push(await submitQueued(h, prompt, 'control-socket'));
    await assertBlocked(h, queued, 'active', { starts: 0, resumes: 0 });
    h.native.setStatus('waitingApproval');
    await h.waitSession('waitingApproval');
    queued.push(await submitQueued(h, '合成审批期间新增任务-3', 'control-socket'));
    await assertBlocked(h, queued, 'waitingApproval', { starts: 0, resumes: 0 });
    h.native.setStatus('unknown');
    await h.waitSession('unknown');
    const denied = await h.submit('合成未知状态禁止新增派发');
    assert.equal(denied.status, 400, 'Unknown native state must not invent a new send route');
    await assertBlocked(h, queued, 'unknown', { starts: 0, resumes: 0 });
    h.native.setStatus('idle');
    await h.waitSession();
    for (const [index, record] of queued.entries()) {
      await assertOriginalDispatch(h, record, index + 1, 'control-socket');
      await h.complete(record.commandId, TASK_RESULT + `BUSY-${index + 1}`);
    }
    await delay(OBSERVE_MS);
    assert.equal(h.native.starts.length, queued.length);
    assert.equal(h.native.resumes.length, 0, 'Loaded control route must never resume');
    assertSingleDispatches(h, queued);
    h.evidence('assertions', { blockedStates: ['active', 'waitingApproval', 'unknown'], blockedMutations: 0,
      unknownAdmission: denied.status, commandIds: queued.map(record => record.commandId), deliveredInOrder: 3,
      startsPerCommand: 1, resumes: 0, frozenRoute: 'control-socket' });
  }],
  ['frozen-resume-route', async h => {
    h.native.setLoaded(false);
    h.native.setStatus('notLoaded');
    await h.waitSession('notLoaded');
    const unloaded = await h.session();
    assert.equal(unloaded.loaded, false);
    assert(unloaded.capabilities.includes('resume-send'), 'Real Daemon must advertise explicit unloaded resume');
    assert(!unloaded.capabilities.includes('send'), 'Unloaded session must not fabricate control-socket send');
    h.control.setOffline(true);
    await h.waitNode(false);
    const queued = [await submitQueued(h, '合成恢复路线-1', 'app-server-resume'),
      await submitQueued(h, '合成恢复路线-2', 'app-server-resume')];
    await delay(OBSERVE_MS);
    assert.equal(h.native.starts.length + h.native.resumes.length, 0, 'Offline admission performed native mutations');
    h.control.setOffline(false);
    await h.waitNode(true);
    const first = await assertOriginalDispatch(h, queued[0], 1, 'app-server-resume');
    assert.equal(h.native.resumes.length, 1, 'First unloaded turn must acquire its original managed writer once');
    assert.equal(h.native.resumes[0].threadId, h.native.sessionId);
    assert.equal(h.native.resumes[0].previouslyLoaded, false);
    assert.equal(h.native.resumes[0].connectionId, first.connectionId, 'Resume and start must use the same native RPC connection');
    for (const status of ['active', 'waitingApproval', 'unknown']) {
      h.native.setStatus(status);
      await h.waitSession(status);
      await assertBlocked(h, [queued[1]], status, { starts: 1, resumes: 1 });
    }
    await h.complete(queued[0].commandId, TASK_RESULT + 'RESUME-1');
    const second = await assertOriginalDispatch(h, queued[1], 2, 'app-server-resume');
    assert.notEqual(second.connectionId, first.connectionId, 'Independent commands must use their own native RPC connections');
    assert.equal(h.native.resumes.length, 1, 'Frozen resume route must reuse the loaded writer without another resume');
    await h.complete(queued[1].commandId, TASK_RESULT + 'RESUME-2');
    await delay(OBSERVE_MS);
    assert.equal(h.native.starts.length, 2);
    assert.equal(h.native.resumes.length, 1);
    assertSingleDispatches(h, queued);
    h.evidence('assertions', { frozenRoute: 'app-server-resume', commandIds: queued.map(record => record.commandId),
      blockedStates: ['active', 'waitingApproval', 'unknown'], blockedAdditionalMutations: 0,
      deliveredInOrder: 2, startsPerCommand: 1, firstTurnResumes: 1, loadedContinuationResumes: 0, routeSwitches: 0 });
  }],
  ['offline-fifo-cancel-restart', async h => {
    h.control.setOffline(true);
    await h.waitNode(false);
    const responses = [];
    for (const prompt of ['合成FIFO-1', '合成FIFO-2', '合成取消项', '合成FIFO-3']) {
      const response = await h.submit(prompt);
      assert.equal(response.status, 202, JSON.stringify(response));
      assert.equal(response.body.status, 'queued');
      responses.push(response.body);
    }
    const cancel = await h.control.request('/v1/commands/' + responses[2].commandId + '/cancel', {});
    assert.equal(cancel.status, 200); assert.equal(cancel.body.status, 'cancelled');
    await h.control.restart();
    for (const record of responses.filter((_, index) => index !== 2)) await h.waitCommand(record.commandId, 'queued');
    h.control.setOffline(false);
    await h.waitNode(true);
    for (const [index, expected] of [responses[0], responses[1], responses[3]].entries()) {
      const start = await h.native.waitForStarts(index + 1);
      assert.equal(start.prompt, expected.prompt, 'Durable FIFO changed across Controller crash');
      await h.waitCommand(expected.commandId, 'accepted');
      await delay(OBSERVE_MS);
      assert.equal(h.native.starts.length, index + 1, 'Queue bypassed accepted active task');
      await h.complete(expected.commandId, TASK_RESULT + `FIFO-${index + 1}`);
    }
    await delay(OBSERVE_MS);
    assert.equal(h.native.starts.length, 3);
    assert(!h.native.starts.some(start => start.prompt === responses[2].prompt), 'Cancelled command reached native dispatch');
    assert.equal((await h.command(responses[2].commandId)).status, 'cancelled');
    h.evidence('assertions', { queued: 4, deliveredInOrder: 3, cancelledDeliveries: 0, controllerCrash: true });
  }],
  ['offline-expiry', async h => {
    h.control.setOffline(true); await h.waitNode(false);
    const response = await h.submit('合成过期项：到期后禁止执行');
    assert.equal(response.status, 202); assert.equal(response.body.status, 'queued');
    await h.control.restart();
    await h.waitCommand(response.body.commandId, 'expired');
    h.control.setOffline(false); await h.waitNode(true);
    await delay(OBSERVE_MS);
    assert.equal(h.native.starts.length, 0, 'Expired queued task was executed on reconnect');
    h.evidence('assertions', { expired: 1, dispatchesAfterReconnect: 0, realClockExpiry: true });
  }],
];

async function submitQueued(h, prompt, route) {
  const response = await h.submit(prompt);
  h.evidence('busy-admission-response', { response, session: await h.session() });
  assert.equal(response.status, 202, JSON.stringify(response));
  assert.equal(response.body.status, 'queued', 'Blocked target must durably queue the original command');
  assert.equal(response.body.sendRoute, route, 'Admission chose the wrong durable native route');
  return response.body;
}

async function assertBlocked(h, commands, state, { starts, resumes }) {
  await delay(OBSERVE_MS);
  h.healthy();
  assert.equal(h.native.starts.length, starts, `${state} permitted a turn/start mutation`);
  assert.equal(h.native.resumes.length, resumes, `${state} permitted a thread/resume mutation`);
  for (const original of commands) {
    const record = await h.command(original.commandId);
    assert.equal(record.status, 'queued', `${state} lost the original durable queue entry`);
    assert.equal(record.sendRoute, original.sendRoute, `${state} changed the frozen route`);
    assert.equal(record.requestId, original.requestId);
  }
  h.evidence('blocked-native-mutations', { state, commandIds: commands.map(record => record.commandId), starts, resumes });
}

async function assertOriginalDispatch(h, original, count, route) {
  const start = await h.native.waitForStarts(count);
  const accepted = await h.waitCommand(original.commandId, 'accepted');
  assert.equal(start.prompt, original.prompt, 'Native FIFO differs from original command order');
  assert.equal(start.threadId, original.sessionId, 'Native turn crossed session ownership');
  assert.equal(accepted.commandId, original.commandId);
  assert.equal(accepted.requestId, original.requestId);
  assert.equal(accepted.turnId, start.turnId, 'Receipt bound another native turn');
  assert.equal(accepted.sendRoute, route, 'Dispatch switched the durable route');
  return start;
}

function assertSingleDispatches(h, commands) {
  for (const original of commands) {
    const frames = h.control.frames.filter(frame => frame.direction === 'controller-daemon' &&
      frame.type === 'command' && frame.commandId === original.commandId);
    assert.equal(frames.length, 1, 'Original command was dispatched more than once');
    assert.equal(frames[0].sendRoute, original.sendRoute, 'Wire command switched native routes');
    assert.equal(h.native.starts.filter(start => start.prompt === original.prompt).length, 1);
  }
}
