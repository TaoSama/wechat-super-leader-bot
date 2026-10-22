import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createDecipheriv, createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { verificationEnvironment } from '../../../scripts/verify.mjs';
import { stopTestProcess, withTestCleanup } from '../../support/cleanup.mjs';
import { createControllerFixture, waitFor } from '../../support/control-plane-fixture.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CHAT = 'synthetic-result-gateway-chat';
const CONTEXT = 'synthetic-result-context';
const SUMMARY = '模型摘要：任务成果已完成，完整正文随附件提供。';
const REPLY = '模型回复：已收到你的当前消息。';
const PROCESS_MS = 30_000;
const HTTP_MS = 5_000;
const WINDOW_MS = 23 * 60 * 60_000;
const RENEWAL_TEXT = '还有任务更新待接收。发一条消息，可以继续接收后续更新。';
const hash = (type, data) => createHash(type).update(data).digest('hex');
const { values } = parseArgs({ options: { run: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
if (!values.run || values.help) {
  console.log('Usage: node tests/integration/leader/result-gateway.mjs --run\nRequires built Controller/Gateway, Node >=24 and OpenSSL. Starts actual CLI processes with a local model, HTTPS iLink fixture and isolated CDN fetch mapping. No production endpoints or credentials are used.');
} else {
  await verifyResultGateway().catch(error => { console.error(error); process.exitCode = 1; });
}

async function listen(server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port;
}
async function closeServer(server) {
  if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
async function jsonBody(request) {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function respond(response, body) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); }

export async function verifyResultGateway() {
  const env = verificationEnvironment(), token = randomUUID(), logs = [], errors = [];
  const dir = await mkdtemp(join(tmpdir(), 'super-leader-result-gateway-'));
  const accountPath = join(dir, 'account.json'), statePath = join(dir, 'state.json');
  const certPath = join(dir, 'localhost-cert.pem'), keyPath = join(dir, 'localhost-key.pem');
  const preloadPath = join(dir, 'cdn-fixture.mjs');
  const sent = [], incoming = [], uploads = new Map(), events = [], modelRequests = [];
  let controller, model, wechat, gatewayChild, cursor = 0, dropNext = false, crashNext = false;
  const healthy = () => { if (errors.length) throw errors[0]; };
  await withTestCleanup(async () => {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-sha256',
      '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', keyPath, '-out', certPath],
    { env, timeout: HTTP_MS, stdio: ['ignore', 'pipe', 'pipe'] });
    model = createServer(async (request, response) => {
      try {
        assert.equal(request.url, '/v1/responses');
        const payload = await jsonBody(request);
        const summary = payload.input[0]?.content?.includes('真实执行成果');
        if (summary) assert.equal(payload.tools?.length ?? 0, 0, 'Summary model was granted tools');
        modelRequests.push({ summary });
        respond(response, { status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: summary ? SUMMARY : REPLY }] }] });
      } catch (error) { errors.push(error); response.writeHead(500); response.end(); }
    });
    const modelPort = await listen(model);
    const cleared = Object.fromEntries(Object.keys(process.env).map(key => [key, undefined]));
    controller = await createControllerFixture({ logs, secrets: [token], env: { ...cleared, ...env,
      CONTROLLER_TOKEN: token, NODE_TOKENS: '{}', ALLOWED_CHAT_IDS: CHAT, PERSISTENCE_MODE: 'memory',
      TASK_NOTIFICATION_TICK_MS: '100', LEADER_MODE: 'model',
      LEADER_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, LEADER_MODEL_API_KEY: 'synthetic-key', LEADER_MODEL_NAME: 'synthetic-model',
    } });
    await controller.start();
    wechat = createHttpsServer({ key: await readFile(keyPath), cert: await readFile(certPath) }, async (request, response) => {
      try {
        const url = new URL(request.url, 'https://synthetic.invalid');
        if (url.pathname === '/c2c/upload') {
          assert.equal(request.headers.authorization, undefined, 'CDN upload leaked iLink bearer credential');
          const upload = uploads.get(url.searchParams.get('filekey'));
          assert(upload, 'CDN upload did not bind prior getuploadurl authorization');
          const chunks = []; for await (const chunk of request) chunks.push(chunk);
          upload.ciphertext = Buffer.concat(chunks);
          assert.equal(upload.ciphertext.length, upload.authorization.filesize);
          const decipher = createDecipheriv('aes-128-ecb', Buffer.from(upload.authorization.aeskey, 'hex'), null);
          upload.plaintext = Buffer.concat([decipher.update(upload.ciphertext), decipher.final()]);
          assert.equal(upload.plaintext.length, upload.authorization.rawsize);
          assert.equal(hash('md5', upload.plaintext), upload.authorization.rawfilemd5);
          events.push('cdn-upload');
          response.writeHead(200, { 'x-encrypted-param': `download-${upload.authorization.filekey}` }); response.end(); return;
        }
        assert.equal(request.headers.authorization, 'Bearer synthetic-wechat-token');
        const body = await jsonBody(request);
        if (url.pathname === '/ilink/bot/getupdates') {
          respond(response, { ret: 0, get_updates_buf: `cursor-${++cursor}`, msgs: incoming.splice(0) }); return;
        }
        if (url.pathname === '/ilink/bot/getconfig') {
          assert.equal(body.ilink_user_id, CHAT); assert.equal(body.context_token, CONTEXT);
          respond(response, { ret: 0, typing_ticket: 'synthetic-ticket' }); return;
        }
        if (url.pathname === '/ilink/bot/sendtyping') {
          assert.equal(body.ilink_user_id, CHAT); assert.equal(body.typing_ticket, 'synthetic-ticket');
          events.push('typing'); respond(response, { ret: 0 }); return;
        }
        if (url.pathname === '/ilink/bot/getuploadurl') {
          assert.equal(body.to_user_id, CHAT); assert.equal(body.media_type, 3);
          assert.equal(body.filesize % 16, 0); assert.equal(body.aeskey.length, 32);
          uploads.set(body.filekey, { authorization: body });
          respond(response, { ret: 0, upload_param: `upload-${body.filekey}` }); return;
        }
        assert.equal(url.pathname, '/ilink/bot/sendmessage');
        assert.equal(body.msg.to_user_id, CHAT); assert.equal(body.msg.context_token, CONTEXT);
        assert.equal(body.msg.item_list.length, 1);
        const item = body.msg.item_list[0];
        if (item.type === 4) {
          const filekey = item.file_item.media.encrypt_query_param.replace(/^download-/, '');
          const uploaded = uploads.get(filekey);
          assert(uploaded?.plaintext, 'File sent before CDN upload completed');
          assert.equal(item.file_item.len, String(uploaded.plaintext.length));
          assert.equal(Buffer.from(item.file_item.media.aes_key, 'base64').toString('utf8'), uploaded.authorization.aeskey);
          assert.equal(item.file_item.media.encrypt_type, 1);
          assert.match(item.file_item.file_name, /^result-.*\.md$/);
        } else { assert.equal(item.type, 1); assert(item.text_item.text.length <= 3800); }
        sent.push(body.msg); events.push(item.type === 4 ? 'file-send' : 'text-send');
        if (crashNext) { crashNext = false; gatewayChild.kill('SIGKILL'); response.destroy(); return; }
        if (dropNext) { dropNext = false; response.destroy(); return; }
        respond(response, { ret: 0, errcode: 0 });
      } catch (error) { errors.push(error); response.writeHead(500); response.end(); }
    });
    const wechatPort = await listen(wechat);
    const wechatOrigin = `https://127.0.0.1:${wechatPort}`;
    await writeFile(accountPath, JSON.stringify({ token: 'synthetic-wechat-token', accountId: 'synthetic-account', baseUrl: wechatOrigin }), { mode: 0o600 });
    // The production CDN hostname stays hard-validated by the application. Only
    // this isolated child preload maps its final fetch onto the HTTPS fixture.
    await writeFile(preloadPath, `const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.origin === 'https://novac2c.cdn.weixin.qq.com' && url.pathname === '/c2c/upload') {
    return realFetch(${JSON.stringify(wechatOrigin)} + url.pathname + url.search, init);
  }
  if (![${JSON.stringify(wechatOrigin)}, ${JSON.stringify(controller.base)}].includes(url.origin)) throw new Error('Fixture blocked external fetch');
  const response = await realFetch(input, init);
  if (!response.ok && url.origin === ${JSON.stringify(controller.base)}) console.error('Synthetic Controller rejection', url.pathname, response.status, await response.clone().text());
  return response;
};\n`, { mode: 0o600 });
    const runGateway = async (mode = '--poll-once', { allowFailure = false, budget = 10 } = {}) => {
      healthy(); let output = '', stderr = '';
      gatewayChild = spawn(process.execPath, ['--import', preloadPath, 'gateway/dist/index.js', mode,
        '--controller-url', controller.base, '--credentials-path', accountPath, '--state-path', statePath,
        '--health-path', join(dir, 'health.json')], {
        cwd: ROOT, env: { ...env, CONTROLLER_TOKEN: token, NODE_EXTRA_CA_CERTS: certPath,
          GATEWAY_SEND_BUDGET: String(budget), GATEWAY_CONTEXT_WINDOW_MS: String(WINDOW_MS) }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      gatewayChild.stdout.on('data', bytes => { output += bytes; }); gatewayChild.stderr.on('data', bytes => { stderr += bytes; });
      const timer = setTimeout(() => { errors.push(new Error('Gateway CLI timeout')); gatewayChild.kill('SIGTERM'); }, PROCESS_MS);
      let exit, signal;
      try { [exit, signal] = await once(gatewayChild, 'exit'); } finally { clearTimeout(timer); }
      gatewayChild = undefined; healthy();
      if (!allowFailure) assert.equal(exit, 0, `Gateway CLI ${mode} failed: ${stderr}${output}`);
      return { exit, signal, output, stderr };
    };
    const state = async () => JSON.parse(await readFile(statePath, 'utf8'));
    const elapseDispatchInterval = async () => {
      const outboxPath = `${statePath}.results.json`;
      const persisted = JSON.parse(await readFile(outboxPath, 'utf8'));
      // Fixture time passage between independent scenarios; keep all delivery,
      // account, budget and attempt evidence unchanged.
      persisted.dispatchTimes[CHAT] = Date.now() - 60_001;
      await writeFile(outboxPath, JSON.stringify(persisted), { mode: 0o600 });
    };
    const patchBudget = async patch => {
      const persisted = await state();
      assert(persisted.context_budgets?.[CHAT], 'True inbound did not create persistent context budget');
      Object.assign(persisted.context_budgets[CHAT], patch);
      await writeFile(statePath, JSON.stringify(persisted), { mode: 0o600 });
    };
    const input = async (text = '当前消息', messageId = randomUUID(), createdAt = Date.now()) => {
      const inbound = { message_type: 1, from_user_id: CHAT, client_id: messageId, create_time_ms: createdAt,
        context_token: CONTEXT, item_list: [{ type: 1, text_item: { text } }] };
      incoming.push(inbound); await runGateway(); return inbound;
    };
    const plans = async () => {
      const result = await controller.request('/v1/deliveries'); assert.equal(result.status, 200); return result.body.items;
    };
    const getPlan = async id => (await plans()).find(plan => plan.id === id);
    const createSchedule = async body => {
      const key = randomUUID();
      const response = await fetch(`${controller.base}/v1/automations`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify(body), signal: AbortSignal.timeout(HTTP_MS),
      });
      return { status: response.status, body: await response.json() };
    };
    const prepare = async text => {
      const result = await createSchedule({ chatId: CHAT, input: {
        kind: 'reminder', title: 'synthetic runtime result', text, timezone: 'UTC', retention: 'retain',
        timing: { type: 'at', at: new Date(Date.now() + 500).toISOString() },
      } });
      assert.equal(result.status, 201, JSON.stringify(result.body));
      let plan; await waitFor(async () => {
        healthy(); plan = (await plans()).find(item => item.source.id === result.body.schedule.id && item.status === 'ready'); return Boolean(plan);
      }, 'Scheduled result prepared through Controller tick');
      return plan;
    };
    const textOf = message => message.item_list[0].text_item?.text;
    await runGateway('--establish-baseline');
    const original = await input();
    assert.equal(sent.length, 1); assert.equal(textOf(sent[0]), REPLY);
    assert.equal((await state()).context_budgets[CHAT].remaining, 9);
    assert(events.includes('typing'));

    const threeDisplayText = '甲'.repeat(11400), threeText = `**${threeDisplayText}**`;
    const three = await prepare(threeText), beforeThree = sent.length;
    await runGateway();
    assert.equal((await getPlan(three.id)).status, 'accepted');
    assert.deepEqual(sent.slice(beforeThree).map(textOf).map(text => text.length), [3800, 3800, 3800]);
    assert.equal(sent.slice(beforeThree).map(textOf).join(''), threeDisplayText,
      'Emphasis spanning all three messages was not rendered before the immutable split');
    const threeFull = await fetch(`${controller.base}/v1/deliveries/${three.id}/full`, {
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(HTTP_MS),
    });
    assert.equal(threeFull.status, 200);
    assert.equal(await threeFull.text(), threeText, 'Displayed text replaced the original Markdown artifact');
    assert.equal(modelRequests.filter(item => item.summary).length, 0);
    console.log('PASS actual Gateway CLI sends three complete rendered texts; cross-message emphasis removed before frozen split, raw Markdown artifact retained, shared budget and typing verified');

    await input('刷新窗口');
    const fileText = '# 完整成果\n\n**' + '乙'.repeat(11401) + '**', file = await prepare(fileText), beforeFile = sent.length;
    await runGateway();
    assert.equal((await getPlan(file.id)).status, 'ready');
    assert.equal(sent.length, beforeFile, 'Result dispatch interval was bypassed by CLI restart');
    await elapseDispatchInterval();
    await runGateway();
    assert.equal((await getPlan(file.id)).status, 'accepted');
    assert.equal(textOf(sent[beforeFile]), SUMMARY); assert.equal(sent[beforeFile + 1].item_list[0].type, 4);
    const uploaded = [...uploads.values()].at(-1);
    assert.equal(uploaded.plaintext.toString('utf8'), fileText);
    assert.equal(hash('sha256', uploaded.plaintext), file.artifact.sha256);
    assert(events.indexOf('cdn-upload') < events.indexOf('file-send'));
    console.log('PASS actual CLI sends one HTTP-model summary plus type4 file; real AES-128-ECB upload bytes, plaintext MD5, filelen and full-result SHA256 verified');

    await patchBudget({ remaining: 0 });
    const blocked = await prepare('budget-blocked-result'), countBeforeBlocked = sent.length;
    await runGateway();
    assert.equal((await getPlan(blocked.id)).status, 'waiting_for_user');
    assert.equal(sent.length, countBeforeBlocked);
    const beforeReplayBudget = (await state()).context_budgets[CHAT];
    incoming.push(original); await runGateway();
    assert.deepEqual((await state()).context_budgets[CHAT], beforeReplayBudget, 'Historical input refreshed exhausted budget');
    assert.equal(sent.length, countBeforeBlocked);
    await elapseDispatchInterval();
    await input('续期并取结果');
    assert.equal(textOf(sent[countBeforeBlocked]), REPLY, 'Pending result preempted current user reply');
    assert.equal(textOf(sent[countBeforeBlocked + 1]), 'budget-blocked-result');
    assert.equal((await getPlan(blocked.id)).status, 'accepted');
    console.log('PASS budget exhausted → durable waiting; replay does not refresh; true new inbound gets ordinary reply before result resume');

    await patchBudget({ refreshedAt: Date.now() - WINDOW_MS - 1 });
    const expired = await prepare('window-expired-result'), beforeExpired = sent.length;
    await runGateway(); assert.equal(sent.length, beforeExpired); assert.equal((await getPlan(expired.id)).status, 'waiting_for_user');
    await elapseDispatchInterval();
    await input('重新打开窗口'); assert.equal((await getPlan(expired.id)).status, 'accepted');
    console.log('PASS expired reply window saves waiting result; new inbound resumes without rerunning scheduled task');

    const unknown = await prepare('unknown-send-result'), beforeUnknown = sent.length;
    await elapseDispatchInterval();
    dropNext = true; await runGateway('--poll-once', { allowFailure: true });
    assert.equal(sent.length, beforeUnknown + 1);
    await runGateway('--poll-once', { allowFailure: true });
    assert.equal((await getPlan(unknown.id)).status, 'uncertain');
    assert.equal(sent.length, beforeUnknown + 1, 'Lost send response was resent after process restart');

    const crashed = await prepare('crash-after-send-result'), beforeCrash = sent.length;
    await elapseDispatchInterval();
    crashNext = true; const crash = await runGateway('--poll-once', { allowFailure: true });
    assert.equal(crash.signal, 'SIGKILL'); assert.equal(sent.length, beforeCrash + 1);
    await runGateway('--poll-once', { allowFailure: true });
    assert.equal((await getPlan(crashed.id)).status, 'uncertain');
    assert.equal(sent.length, beforeCrash + 1, 'Process crash replayed an in-flight send');
    console.log('PASS lost send response and process killed after submission remain uncertain across real CLI restart without duplicate send');

    await input('新窗口供续期提醒测试');
    const future = await createSchedule({ chatId: CHAT, input: {
      kind: 'reminder', title: 'synthetic future task', text: 'future-result', timezone: 'UTC',
      timing: { type: 'at', at: new Date(Date.now() + 3_600_000).toISOString() },
    } }); assert.equal(future.status, 201);
    await patchBudget({ remaining: 2, refreshedAt: Date.now() - 21 * 60 * 60_000 });
    const beforeEarly = sent.length;
    await runGateway();
    assert.equal(sent.length, beforeEarly, 'Low budget reminder was sent before the final hour');
    await patchBudget({ remaining: 3, refreshedAt: Date.now() - 22 * 60 * 60_000 - 1000 });
    await runGateway();
    assert.equal(sent.length, beforeEarly, 'Reminder consumed quota when at least three sends remained');
    await patchBudget({ remaining: 2 });
    const beforeRenewal = sent.filter(message => textOf(message) === RENEWAL_TEXT).length;
    await runGateway(); await runGateway();
    assert.equal(sent.filter(message => textOf(message) === RENEWAL_TEXT).length, beforeRenewal + 1, 'Window renewal reminder was missing or repeated across restart');
    assert.equal((await state()).context_budgets[CHAT].remaining, 1);
    console.log('PASS future task reminder requires final hour and 1–2 sends; durable deduplication survives CLI restart');

    await input('提醒使用最后一次额度');
    const lastQuota = await prepare('saved-after-last-quota-reminder');
    await elapseDispatchInterval();
    await patchBudget({ remaining: 1, refreshedAt: Date.now() - 22 * 60 * 60_000 - 1000 });
    const beforeLastQuota = sent.length;
    await runGateway();
    assert.deepEqual(sent.slice(beforeLastQuota).map(textOf), [RENEWAL_TEXT]);
    assert.equal((await state()).context_budgets[CHAT].remaining, 0);
    assert.equal((await getPlan(lastQuota.id)).status, 'waiting_for_user');
    await runGateway();
    assert.equal(sent.length, beforeLastQuota + 1, 'Restart repeated reminder or exhausted result');
    const modelCallsBeforeResume = modelRequests.length;
    await input('刷新额度恢复排队成果');
    assert.deepEqual(sent.slice(beforeLastQuota).map(textOf), [RENEWAL_TEXT, REPLY, 'saved-after-last-quota-reminder']);
    assert.equal((await getPlan(lastQuota.id)).status, 'accepted');
    assert.equal(modelRequests.length, modelCallsBeforeResume + 1, 'Result recovery reran the model');
    console.log('PASS reminder takes final quota before ready result; persisted result resumes once after true inbound');

    await input('分段发送期间提醒优先');
    const splitText = '首'.repeat(3800) + '中'.repeat(3800) + '尾'.repeat(3800);
    const interrupted = await prepare(splitText);
    await elapseDispatchInterval();
    await patchBudget({ remaining: 3, refreshedAt: Date.now() - 22 * 60 * 60_000 - 1000 });
    const beforeSplit = sent.length;
    await runGateway();
    assert.deepEqual(sent.slice(beforeSplit).map(textOf), [splitText.slice(0, 3800), RENEWAL_TEXT],
      'Reminder did not preempt the next result chunk as quota crossed from three to two');
    assert.equal((await state()).context_budgets[CHAT].remaining, 1);
    await runGateway();
    assert.equal(sent.length, beforeSplit + 2, 'Restart duplicated an accepted chunk or reminder');
    await elapseDispatchInterval();
    await input('继续未发送分段');
    assert.deepEqual(sent.slice(beforeSplit).map(textOf), [splitText.slice(0, 3800), RENEWAL_TEXT, REPLY,
      splitText.slice(3800, 7600), splitText.slice(7600)]);
    assert.equal((await getPlan(interrupted.id)).status, 'accepted');
    console.log('PASS three-chunk result yields at 3→2 quota; restart preserves accepted chunk; inbound resumes only remaining chunks');
    assert.equal(new Set(sent.map(message => message.client_id)).size, sent.length, 'Duplicate external client_id was sent');
    console.log(`PASS whole-result Gateway CLI runtime; ${sent.length} actual synthetic sendmessage requests, ${uploads.size} encrypted CDN uploads`);
  }, [
    { label: 'synthetic Gateway CLI process', cleanup: () => stopTestProcess(gatewayChild) },
    { label: 'synthetic Controller process', cleanup: () => controller?.stop() },
    { label: 'synthetic HTTPS iLink and CDN', cleanup: () => closeServer(wechat) },
    { label: 'synthetic HTTP model', cleanup: () => closeServer(model) },
    { label: 'private fixture files', cleanup: () => rm(dir, { recursive: true, force: true }) },
  ]).catch(error => { console.error('Controller diagnostic tail:', logs.join('').slice(-4000)); throw error; });
}
