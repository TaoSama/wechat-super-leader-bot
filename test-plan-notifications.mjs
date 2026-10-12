import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PLAN_CHAT } from './test-plan-execution.mjs';

const HTTP_MS = 5000;
const MAX_DRAINS = 10;
const ILINK_BASE = 'https://ilink.notification.invalid';
const CLIENT_ID_PREFIX = 'super-leader:notification:';
const TEXT_ITEM_TYPE = 1;
const notificationPath = id => '/v1/notifications/' + id;

// Actual Gateway classes -> actual HTTP Controller -> actual disposable PostgreSQL.
// Only iLink is simulated, and its injected fetch rejects every unexpected target.
export async function verifyPlanNotifications({ base, token, request, store, restart, planIds }) {
  const { StateManager, writePrivateJsonSync } = await import('./gateway/dist/state.js');
  const { ControllerClient } = await import('./gateway/dist/controller_client.js');
  const { ILinkClient } = await import('./gateway/dist/ilink.js');
  const { WeChatGateway } = await import('./gateway/dist/gateway.js');
  const { createExecution } = await import('./controller/dist/leader/execution.js');
  const dir = await mkdtemp(join(tmpdir(), 'super-leader-notification-test-'));
  const credentials = join(dir, 'synthetic-account.json');
  const statePath = join(dir, 'synthetic-state.json');
  const sent = [], gateways = [];
  let providerMode = 'success', state;
  const pending = () => request('/v1/notifications/pending', { chatIds: [PLAN_CHAT] });
  const get = async id => {
    const response = await request(notificationPath(id));
    assert.equal(response.status, 200);
    return response.body.notification;
  };
  const transport = async (input, init) => {
    assert.equal(String(input), ILINK_BASE + '/ilink/bot/sendmessage', 'Attempt to contact an unapproved external endpoint');
    const payload = JSON.parse(init.body);
    assert.equal(payload.msg.to_user_id, PLAN_CHAT);
    assert.equal(payload.msg.context_token, 'synthetic-context');
    assert(payload.msg.client_id.startsWith(CLIENT_ID_PREFIX));
    const persisted = await get(payload.msg.client_id.slice(CLIENT_ID_PREFIX.length));
    assert.equal(persisted.status, 'claimed', 'Provider send has no durable claim');
    assert.deepEqual(payload.msg.item_list, [{ type: TEXT_ITEM_TYPE, text_item: { text: persisted.text } }],
      'Provider text differs from the immutable persisted notification');
    sent.push(payload.msg);
    if (providerMode === 'drop') throw new TypeError('Synthetic send response lost after submission');
    return new Response(JSON.stringify(providerMode === 'empty' ? {} : providerMode === 'rejected' ? { ret: -14 } : { ret: 0, errcode: 0 }),
      { headers: { 'content-type': 'application/json' } });
  };
  const makeGateway = (options = {}) => {
    const instance = new WeChatGateway({
      stateManager: options.state ?? state,
      ilink: new ILinkClient({ stateManager: options.state ?? state, fetchImpl: transport }),
      controller: new ControllerClient({ controllerUrl: base, controllerToken: token, fetchImpl: options.fetchImpl ?? fetch }),
      notifications: options.enabled ?? true,
    });
    gateways.push(instance);
    return instance;
  };
  const addFailure = async () => {
    const now = Date.now();
    const record = createExecution(PLAN_CHAT, { id: randomUUID(), expiresAt: now + 60_000,
      actions: [{ nodeId: 'notification-fixture', sessionId: 'unused', prompt: 'must-not-be-sent',
        sendRoute: 'control-socket', dependsOn: [] }] }, now);
    await store.createExecutionIfAbsent(record);
    await store.compareAndSetExecution({ ...record, revision: 2, status: 'failed' }, 1, now);
    return record.id;
  };
  try {
    writePrivateJsonSync(credentials, { token: 'synthetic-notification-token', accountId: 'synthetic-account', baseUrl: ILINK_BASE });
    state = new StateManager(credentials, statePath);
    state.markBaselineEstablished();
    assert.equal((await get(planIds.completed)).kind, 'completed', 'Exact real plan completion has no notification');
    assert.equal((await get(planIds.failed)).kind, 'failed');
    assert.equal((await request(notificationPath(planIds.cancelled))).status, 404, 'Cancel reply was duplicated as a proactive notification');
    assert.equal((await request('/v1/notifications/pending', { chatIds: [PLAN_CHAT] }, false)).status, 401);

    const issued = await request('/v1/console-links', { requestId: 'notification-cookie-' + randomUUID() });
    const linkToken = new URLSearchParams(new URL(issued.body.url).hash.slice(1)).get('login');
    const exchanged = await fetch(base + '/auth/exchange', { method: 'POST',
      headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ token: linkToken }),
      signal: AbortSignal.timeout(HTTP_MS) });
    assert.equal(exchanged.status, 200);
    const cookie = exchanged.headers.get('set-cookie').split(';')[0];
    await exchanged.arrayBuffer();
    try {
      for (const [path, body] of [[notificationPath(planIds.completed), undefined],
        ['/v1/notifications/pending', { chatIds: [PLAN_CHAT] }],
        [notificationPath(planIds.completed) + '/claim', { attemptId: randomUUID() }],
        [notificationPath(planIds.completed) + '/receipt', { attemptId: randomUUID(), status: 'accepted' }]]) {
        const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
          headers: { cookie, origin: base, 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(HTTP_MS) });
        assert.equal(response.status, 401, 'Console cookie was granted notification transport authority');
        await response.arrayBuffer();
      }
    } finally {
      const response = await fetch(base + '/auth/logout', { method: 'POST', headers: { cookie, origin: base }, signal: AbortSignal.timeout(HTTP_MS) });
      assert.equal(response.status, 200);
      await response.arrayBuffer();
    }

    const before = (await pending()).body.items.map(item => item.id);
    assert(before.length > 0);
    await makeGateway().deliverNotificationsOnce(); // No chat context: no claim.
    assert.equal(sent.length, 0);
    assert.deepEqual((await pending()).body.items.map(item => item.id), before);
    state.setContextToken(PLAN_CHAT, 'synthetic-context');
    state.saveState();
    await makeGateway({ enabled: false }).deliverNotificationsOnce();
    assert.equal(sent.length, 0, 'Default-off control ignored');

    const first = makeGateway(), competitor = makeGateway();
    const racers = await Promise.allSettled([first.deliverNotificationsOnce(), competitor.deliverNotificationsOnce()]);
    assert(racers.some(result => result.status === 'fulfilled'), 'Neither gateway made progress');
    for (let index = 0; (await pending()).body.items.length && index < MAX_DRAINS; index++) await first.deliverNotificationsOnce();
    assert.equal((await pending()).body.items.length, 0);
    assert(sent.length >= before.length);
    assert.equal(new Set(sent.map(item => item.client_id)).size, sent.length, 'Concurrent gateways sent the same notification twice');
    assert.equal((await get(planIds.completed)).status, 'accepted');
    assert(sent.some(item => item.client_id === 'super-leader:notification:' + planIds.completed));
    console.log('PASS exact completed plan → durable notification → actual Gateway/HTTP → simulated WeChat; cookie denied, no-context/default-off preserved, concurrent sends unique');

    const lostClaim = await addFailure();
    let claims = 0;
    const lossyClaim = makeGateway({ fetchImpl: async (input, init) => {
      const response = await fetch(input, init);
      if (new URL(String(input)).pathname.endsWith('/claim')) {
        claims++;
        assert.equal(response.status, 200);
        await response.arrayBuffer();
        throw new TypeError('Synthetic claim response loss');
      }
      return response;
    } });
    const countBeforeLoss = sent.length;
    await assert.rejects(lossyClaim.deliverNotificationsOnce());
    assert.equal(claims, 1, 'Claim transport retried');
    assert.equal(sent.length, countBeforeLoss, 'Lost claim response caused an external send');
    const lostRecord = await get(lostClaim);
    assert.equal(lostRecord.status, 'claimed');
    assert.equal((await store.getNotification(lostClaim, lostRecord.attemptExpiresAt)).status, 'uncertain');
    await restart(true);
    const restored = new StateManager(credentials, statePath);
    await makeGateway({ state: restored }).deliverNotificationsOnce();
    assert.equal(sent.length, countBeforeLoss, 'Restart replayed a claimed notification');

    for (const mode of ['empty', 'rejected', 'drop']) {
      const id = await addFailure();
      providerMode = mode;
      const count = sent.length;
      const summary = await first.deliverNotificationsOnce();
      const expectedStatus = mode === 'empty' ? 'accepted' : 'uncertain';
      assert.equal(summary[expectedStatus], 1);
      assert.equal(sent.length, count + 1);
      const receipt = await get(id);
      assert.equal(receipt.status, expectedStatus);
      providerMode = 'success';
      await restart(true);
      await first.deliverNotificationsOnce();
      assert.deepEqual(await get(id), receipt, 'Restart rewrote a permanent receipt');
      assert.equal(sent.length, count + 1, 'Attempted send was automatically replayed');
    }

    const lostReceipt = await addFailure();
    const receiptBodies = [];
    const receiptGateway = makeGateway({ fetchImpl: async (input, init) => {
      const response = await fetch(input, init);
      if (new URL(String(input)).pathname.endsWith('/receipt')) {
        receiptBodies.push(String(init.body));
        if (receiptBodies.length === 1) {
          assert.equal(response.status, 200);
          await response.arrayBuffer();
          throw new TypeError('Synthetic receipt response loss');
        }
      }
      return response;
    } });
    const countBeforeReceipt = sent.length;
    await receiptGateway.deliverNotificationsOnce();
    assert(receiptBodies.length >= 2 && receiptBodies.length <= 3);
    assert.equal(new Set(receiptBodies).size, 1, 'Receipt retry changed its identity');
    assert.equal(sent.length, countBeforeReceipt + 1, 'Receipt retry caused another external send');
    assert.equal((await get(lostReceipt)).status, 'accepted');

    const revoked = await addFailure();
    assert((await pending()).body.items.some(item => item.id === revoked));
    await restart(false);
    assert.equal((await pending()).body.items.length, 0);
    assert.equal((await request(notificationPath(revoked) + '/claim', { attemptId: randomUUID() })).status, 409);
    assert.equal((await get(revoked)).status, 'pending');
    await restart(true);
    await first.deliverNotificationsOnce();
    assert.equal((await get(revoked)).status, 'accepted');
    assert.equal(new Set(sent.map(item => item.client_id)).size, sent.length);
    console.log('PASS notification empty-object acceptance, rejected/lost response uncertainty, claim/receipt-response loss, allowlist revoke/restore and Controller/Gateway restart: no receipt rewrite or external replay');
  } finally {
    for (const gateway of gateways) gateway.stop();
    await rm(dir, { recursive: true, force: true });
  }
}
