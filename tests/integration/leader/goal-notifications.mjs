import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GOAL_CHAT } from './goals.mjs';
import { withTestCleanup } from '../../support/cleanup.mjs';

const PROVIDER = 'https://goal-notification.invalid';
const CLIENT_PREFIX = 'super-leader:notification:';
const MAX_DRAINS = 10;

// Uses goals completed by the real HTTP/model/WS fixture, never invented completion records.
export async function verifyGoalNotifications({ base, token, request, store, restart, goalIds }) {
  assert(goalIds.length > 2);
  const { StateManager, writePrivateJsonSync } = await import('../../../gateway/dist/runtime/state.js');
  const { ControllerClient } = await import('../../../gateway/dist/controller/client.js');
  const { WeChatGateway } = await import('../../../gateway/dist/gateway.js');
  const { ILinkClient } = await import('../../../gateway/dist/wechat/client.js');
  const { markdownToWeChat, DEFAULT_MESSAGE_MAX_CHARS } = await import('../../../gateway/dist/wechat/markdown.js');
  const dir = await mkdtemp(join(tmpdir(), 'super-leader-goal-notification-'));
  const credentials = join(dir, 'account.json'), statePath = join(dir, 'state.json');
  const sent = [], gateways = [];
  let uncertainId;
  await withTestCleanup(async () => {
    const expected = [];
    for (const id of goalIds) {
      const goal = await store.getGoal(id), notification = await store.getNotification(id, Date.now());
      if (goal.status === 'completed') {
        assert.equal(notification?.kind, 'completed');
        assert.match(notification.text, /完成状态基于精确回执的条件判断/);
        assert.match(notification.text, /PRIVATE_GOAL_RESULT/);
        uncertainId ??= id;
      } else if (goal.blockedReason) assert.equal(notification?.kind, 'blocked');
      else { assert.equal(goal.status, 'cancelled'); assert.equal(notification, null); continue; }
      assert.deepEqual(notification.source, { type: 'goal', id });
      assert(notification.text.includes(goal.proposal.objective));
      assert.equal(notification.executionId, undefined);
      expected.push(id);
    }
    assert(uncertainId && expected.length > 1);
    const pending = async () => {
      const response = await request('/v1/notifications/pending', { chatIds: [GOAL_CHAT] });
      assert.equal(response.status, 200);
      assert(response.body.items.every(item => item.chatId === GOAL_CHAT && expected.includes(item.id)));
      return response.body.items;
    };
    const provider = async (input, init) => {
      assert.equal(String(input), PROVIDER + '/ilink/bot/sendmessage');
      const { msg } = JSON.parse(init.body);
      assert.equal(msg.to_user_id, GOAL_CHAT); assert.equal(msg.context_token, 'synthetic-goal-context');
      assert(msg.client_id.startsWith(CLIENT_PREFIX));
      const id = msg.client_id.slice(CLIENT_PREFIX.length);
      assert(expected.includes(id));
      const { body, status } = await request('/v1/notifications/' + id);
      assert.equal(status, 200); assert.equal(body.notification.status, 'claimed');
      assert.deepEqual(body.notification.source, { type: 'goal', id });
      assert.deepEqual(msg.item_list, [{ type: 1,
        text_item: { text: markdownToWeChat(body.notification.text, DEFAULT_MESSAGE_MAX_CHARS) } }]);
      sent.push(id);
      if (id === uncertainId) throw new TypeError('Synthetic response lost after submission');
      return Response.json({ ret: 0, errcode: 0 });
    };
    writePrivateJsonSync(credentials, { token: 'synthetic-token', accountId: 'synthetic-account', baseUrl: PROVIDER });
    const state = new StateManager(credentials, statePath); state.markBaselineEstablished();
    const make = (notifications = true) => {
      const instance = new WeChatGateway({ stateManager: state, notifications,
        controller: new ControllerClient({ controllerUrl: base, controllerToken: token }),
        ilink: new ILinkClient({ stateManager: state, fetchImpl: provider }) });
      gateways.push(instance); return instance;
    };
    const initial = await pending(); assert(initial.length > 0);
    await make().deliverNotificationsOnce();
    assert.deepEqual(await pending(), initial); assert.equal(sent.length, 0);
    state.setContextToken(GOAL_CHAT, 'synthetic-goal-context'); state.saveState();
    await make(false).deliverNotificationsOnce(); assert.equal(sent.length, 0);
    const gateway = make();
    for (let index = 0; (await pending()).length && index < MAX_DRAINS; index++) await gateway.deliverNotificationsOnce();
    assert.equal((await pending()).length, 0);
    assert.equal(sent.length, expected.length); assert.equal(new Set(sent).size, sent.length);
    for (const id of expected) assert.equal((await store.getNotification(id, Date.now())).status, id === uncertainId ? 'uncertain' : 'accepted');
    const unknown = await store.getNotification(uncertainId, Date.now());
    await restart();
    await make().deliverNotificationsOnce();
    assert.equal(sent.length, expected.length, 'Controller/Gateway restart replayed a goal notification');
    assert.deepEqual(await store.getNotification(uncertainId, Date.now()), unknown);
    assert.equal((await request('/v1/notifications/' + uncertainId + '/claim', { attemptId: randomUUID() })).status, 409);
    console.log('PASS exact HTTP/model/WS completed goals → durable goal notifications → real Gateway/HTTP → simulated WeChat; blocked snapshot survives cancel, explicit cancel silent, no-context/default-off, unknown and restart never replay');
  }, [
    { label: 'goal notification gateways', cleanup: () => { for (const gateway of gateways) gateway.stop(); } },
    { label: 'goal notification synthetic directory', cleanup: () => rm(dir, { recursive: true, force: true }) },
  ]);
}
