import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { parseArgs } from 'node:util';
import { createControllerFixture, createPostgresFixture, waitFor } from '../../support/control-plane-fixture.mjs';
import { withTestCleanup } from '../../support/cleanup.mjs';
import { verificationEnvironment } from '../../../scripts/verify.mjs';

const CHAT = 'synthetic-task-chat';
const OTHER_CHAT = 'synthetic-other-chat';
const HTTP_TIMEOUT_MS = 5_000;
const REMINDER_DELAY_MS = 2_000;
const MODEL_SUMMARY = '模型生成：任务已完成，完整成果随附件或下载入口提供。';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

const { values } = parseArgs({ options: {
  run: { type: 'boolean' }, postgres: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
} });
if (!values.run || values.help) {
  console.log('Usage: node tests/integration/leader/task-notifications.mjs --run [--postgres]\nRequires built Controller. Starts an isolated HTTP Controller and synthetic loopback model; optional --postgres starts and removes its own local Docker PostgreSQL container. Never contacts WeChat, real models or desktop sessions.');
} else {
  await verifyTaskNotifications({ postgres: values.postgres }).catch(error => { console.error(error); process.exitCode = 1; });
}

export async function verifyTaskNotifications({ postgres = false } = {}) {
  const token = randomBytes(32).toString('hex');
  const database = postgres ? createPostgresFixture({ env: verificationEnvironment() }) : undefined;
  const logs = [], modelRequests = [];
  let controller, mockFailure;
  const model = createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/v1/responses');
      assert.equal(req.headers.authorization, 'Bearer synthetic-model-key');
      let body = '';
      for await (const chunk of req) body += chunk;
      const payload = JSON.parse(body);
      assert.equal(payload.model, 'synthetic-summary-model');
      assert.equal(payload.tools?.length ?? 0, 0, 'Summary request unexpectedly allowed tools');
      assert.match(payload.input[0].content, /真实执行成果/);
      const evidence = JSON.parse(payload.input.at(-1).content);
      assert.equal(evidence.source.type, 'automation');
      assert(evidence.excerpt.length > 11_400, 'Model summarized a short result unnecessarily');
      modelRequests.push(evidence);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: MODEL_SUMMARY }] }] }));
    } catch (error) {
      mockFailure = error;
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Synthetic model assertion failed' }));
    }
  });
  await withTestCleanup(async () => {
    model.listen(0, '127.0.0.1');
    await once(model, 'listening');
    const databaseUrl = database ? await database.start() : undefined;
    // The shared launcher overlays process.env; explicitly erase inherited app secrets first.
    const cleared = Object.fromEntries(Object.keys(process.env).map(key => [key, undefined]));
    controller = await createControllerFixture({ env: {
      ...cleared, ...verificationEnvironment(),
      PERSISTENCE_MODE: database ? 'postgres' : 'memory', DATABASE_URL: databaseUrl,
      CONTROLLER_TOKEN: token, NODE_TOKENS: '{}', ALLOWED_CHAT_IDS: `${CHAT},${OTHER_CHAT}`,
      TASK_NOTIFICATION_TICK_MS: '100', RESULT_FILE_MAX_BYTES: '50000',
      LEADER_MODE: 'model', LEADER_MODEL_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`,
      LEADER_MODEL_API_KEY: 'synthetic-model-key', LEADER_MODEL_NAME: 'synthetic-summary-model',
    }, secrets: [token], logs });
    await controller.start();
    const request = async (path, body, { auth = true, key } = {}) => {
      const response = await fetch(controller.base + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${token}` } : {}),
          ...(key ? { 'idempotency-key': key } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      return { status: response.status, body: await response.json() };
    };
    const ok = async (path, body, options) => {
      const result = await request(path, body, options);
      assert(result.status >= 200 && result.status < 300, `${path}: ${JSON.stringify(result)}`);
      return result.body;
    };
    const pending = async (chatId = CHAT) => (await ok('/v1/deliveries/pending', { chatIds: [chatId] })).items;
    const create = async (text, overrides = {}) => {
      const payload = { chatId: CHAT, input: { kind: 'reminder', title: 'Synthetic runtime reminder', text,
        timing: { type: 'at', at: new Date(Date.now() + REMINDER_DELAY_MS).toISOString() }, timezone: 'Asia/Shanghai',
        retention: 'retain', ...overrides } };
      const key = randomUUID();
      const first = await ok('/v1/automations', payload, { key });
      const repeated = await ok('/v1/automations', payload, { key });
      assert.equal(repeated.schedule.id, first.schedule.id, 'Same authorized creation was duplicated');
      assert.equal((await pending()).some(plan => plan.source.id === first.schedule.id), false, 'Reminder emitted a start notification');
      return first.schedule;
    };
    const awaitResult = async schedule => {
      let plan;
      try {
        await waitFor(async () => {
          if (mockFailure) throw mockFailure;
          plan = (await pending()).find(item => item.source.id === schedule.id);
          return Boolean(plan);
        }, `Result of reminder ${schedule.id}`);
      } catch (error) {
        console.error('Runtime diagnostic', { plans: (await ok('/v1/deliveries')).items.map(({ id, status, error: reason, mode }) => ({ id, status, reason, mode })),
          modelCalls: modelRequests.length, controllerLogs: logs.join('') });
        throw error;
      }
      const runs = (await ok(`/v1/automations/${schedule.id}/runs?chatId=${CHAT}`)).items;
      assert.equal(runs.length, 1, 'Tick replayed the same scheduled occurrence');
      assert.equal(runs[0].status, 'completed');
      return plan;
    };
    const claim = async plan => {
      const attemptId = randomUUID();
      await ok(`/v1/deliveries/${plan.id}/claim`, { attemptId });
      return { attemptId, delivery: (await ok(`/v1/deliveries/${plan.id}/materialize`, { attemptId })).delivery };
    };
    const download = async delivery => {
      const url = delivery.artifact.downloadUrl;
      assert.equal(new URL(url).origin, controller.base);
      const response = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-disposition'), /^attachment;/);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(bytes.length, delivery.artifact.size);
      assert.equal(sha256(bytes), delivery.artifact.sha256, 'Full artifact checksum mismatch');
      return bytes;
    };

    assert.equal((await request('/v1/automations?chatId=' + CHAT, undefined, { auth: false })).status, 401);
    assert.equal((await request('/v1/deliveries/pending', { chatIds: [CHAT] }, { auth: false })).status, 401);
    assert.equal((await request('/v1/automations', { chatId: 'blocked', input: {} })).status, 400);
    const invalid = { kind: 'reminder', title: 'blocked', text: 'not sent', timing: { type: 'at', at: new Date(Date.now() + 60_000).toISOString() }, timezone: 'Asia/Shanghai' };
    assert.equal((await request('/v1/automations', { chatId: 'blocked', input: invalid })).status, 403);
    console.log('PASS HTTP authentication, malformed input and chat allowlist rejection');

    const threeText = '甲'.repeat(11_400);
    const threeSchedule = await create(threeText);
    assert.equal((await request(`/v1/automations/${threeSchedule.id}?chatId=${OTHER_CHAT}`)).status, 404);
    const three = await awaitResult(threeSchedule);
    assert.equal(three.mode, 'text');
    assert.deepEqual(three.messages.map(text => text.length), [3800, 3800, 3800]);
    assert.equal(three.messages.join(''), threeText, 'Three-message result was clipped');
    assert.equal(modelRequests.length, 0, 'Three-message result was summarized');
    assert.equal((await pending(OTHER_CHAT)).length, 0, 'Result crossed target chat');
    const claimedThree = await claim(three);
    assert.equal((await download(claimedThree.delivery)).toString('utf8'), threeText);
    const deferBody = { attemptId: claimedThree.attemptId, reason: 'budget_exhausted', submittedMessages: 1 };
    const deferred = (await ok(`/v1/deliveries/${three.id}/defer`, deferBody)).delivery;
    assert.equal(deferred.status, 'waiting_for_user');
    assert.equal(deferred.submittedMessages, 1);
    assert.deepEqual((await ok(`/v1/deliveries/${three.id}/defer`, deferBody)).delivery, deferred, 'Lost defer response was not idempotent');
    assert.equal((await request(`/v1/deliveries/${three.id}/defer`, { ...deferBody, reason: 'window_expired' })).status, 409);
    assert.equal((await pending()).some(plan => plan.id === three.id), false);
    assert.equal((await ok('/v1/deliveries/resume', { chatId: OTHER_CHAT })).resumed, 0);
    assert.equal((await ok('/v1/deliveries/resume', { chatId: CHAT })).resumed, 1);
    const resumed = await claim(three);
    assert.equal(resumed.delivery.submittedMessages, 1);
    const receipt = { attemptId: resumed.attemptId, status: 'accepted' };
    assert.equal((await ok(`/v1/deliveries/${three.id}/receipt`, receipt)).delivery.status, 'accepted');
    assert.equal((await ok(`/v1/deliveries/${three.id}/receipt`, receipt)).delivery.status, 'accepted');
    assert.equal((await request(`/v1/deliveries/${three.id}/receipt`, { ...receipt, attemptId: randomUUID() })).status, 409);
    console.log('PASS 11400 characters → exactly three complete texts; durable result SHA, defer replay, chat-specific resume and idempotent receipt');

    const fourText = 'B'.repeat(11_401);
    const fourSchedule = await create(fourText);
    const four = await awaitResult(fourSchedule);
    assert.equal(four.mode, 'attachment');
    assert.deepEqual(four.messages, [MODEL_SUMMARY]);
    assert.equal(modelRequests.length, 1);
    assert.equal(modelRequests[0].excerpt, fourText);
    const claimedFour = await claim(four);
    assert.equal((await download(claimedFour.delivery)).toString('utf8'), fourText);
    const repeatedMaterialized = (await ok(`/v1/deliveries/${four.id}/materialize`, { attemptId: claimedFour.attemptId })).delivery;
    assert.equal(repeatedMaterialized.messages[0], MODEL_SUMMARY);
    assert.equal(modelRequests.length, 1, 'Retry regenerated immutable model summary');
    await ok(`/v1/deliveries/${four.id}/receipt`, { attemptId: claimedFour.attemptId, status: 'uncertain' });
    await ok('/v1/deliveries/resume', { chatId: CHAT });
    assert.equal((await pending()).some(plan => plan.id === four.id), false, 'Unknown send was blindly replayed');
    console.log('PASS 11401 characters → one actual HTTP model summary plus exact complete attachment; retries reuse summary and uncertain delivery stays isolated');

    const hugeText = '大'.repeat(20_000);
    const huge = await awaitResult(await create(hugeText));
    assert.equal(huge.mode, 'download', 'Configured file size threshold was ignored');
    const claimedHuge = await claim(huge);
    assert.equal(claimedHuge.delivery.messages.length, 2);
    assert.equal(claimedHuge.delivery.messages[0], MODEL_SUMMARY);
    assert.equal((await download(claimedHuge.delivery)).toString('utf8'), hugeText);
    const signed = new URL(claimedHuge.delivery.artifact.downloadUrl);
    const downloadStatus = async url => {
      const response = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
      await response.arrayBuffer();
      return response.status;
    };
    assert.equal(await downloadStatus(signed.origin + signed.pathname), 403, 'Unsigned download was allowed');
    const wrongArtifact = new URL(signed); wrongArtifact.pathname = `/v1/result-artifacts/${randomUUID()}/download`;
    assert.equal(await downloadStatus(wrongArtifact), 403, 'Signature was transferable to another artifact');
    const expired = new URL(signed), deadline = Date.now() - 1;
    const secret = sha256(`task-results:${token}`);
    expired.searchParams.set('expires', String(deadline));
    expired.searchParams.set('signature', createHmac('sha256', secret).update(`result-download\n${huge.artifact.id}\n${deadline}`).digest('hex'));
    assert.equal(await downloadStatus(expired), 403, 'Correctly signed expired download was accepted');
    await ok(`/v1/deliveries/${huge.id}/receipt`, { attemptId: claimedHuge.attemptId, status: 'accepted' });
    console.log(`PASS 60000-byte artifact exceeds configured 50000-byte limit → summary + authenticated download; SHA ${huge.artifact.sha256}; missing, expired and cross-artifact signatures rejected`);

    const future = await create('must stay silent', { timing: { type: 'at', at: new Date(Date.now() + 60_000).toISOString() } });
    for (const status of ['paused', 'active', 'cancelled']) {
      assert.equal((await ok(`/v1/automations/${future.id}/status`, { chatId: CHAT, status })).schedule.status, status);
    }
    assert.equal((await ok(`/v1/automations/${future.id}/runs?chatId=${CHAT}`)).items.length, 0);
    assert.equal((await pending()).length, 0, 'Cancelled reminder produced a notification');
    if (database) {
      await controller.stop();
      await controller.start();
      assert.equal((await ok(`/v1/deliveries/${three.id}`)).delivery.status, 'accepted');
      assert.equal((await ok(`/v1/deliveries/${four.id}`)).delivery.status, 'uncertain');
      assert.equal((await download(claimedHuge.delivery)).toString('utf8'), hugeText);
      assert.equal((await ok(`/v1/automations/${future.id}?chatId=${CHAT}`)).schedule.status, 'cancelled');
      assert.equal((await pending()).length, 0, 'Controller restart replayed terminal delivery');
      console.log('PASS PostgreSQL root initialization and Controller process restart preserve schedules, complete artifacts, accepted and uncertain delivery receipts');
    }
    console.log(`PASS task notification runtime via real Controller process, HTTP routes and scheduled ticks (${database ? 'PostgreSQL' : 'memory'}); no external production endpoint used`);
  }, [
    { label: 'synthetic Controller process', cleanup: () => controller?.stop() },
    { label: 'synthetic model HTTP server', cleanup: () => model.listening && new Promise((resolve, reject) => model.close(error => error ? reject(error) : resolve())) },
    { label: 'synthetic PostgreSQL container', cleanup: () => database?.stop() },
  ]);
}
