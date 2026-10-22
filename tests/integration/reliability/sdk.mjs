import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { CHAT, OTHER_CHAT, TASK, TASK_RESULT, waitFor } from './fixture.mjs';
import { currentSdkUserText } from '../../support/reliability-sdk-model.mjs';

const ACCOUNT = 'synthetic-reliability-account';
const SAFE_TEXT = '合成SDK安全续传';
const RENEW_TEXT = '合成SDK真实新消息续期';
const RENEW_REPLY = 'SDK_RENEW_ACCEPTED';
const SAFE_REPLY = 'SDK_PERSISTED_FINAL_' + 'abcdefghijklmnopqrstuvwxyz0123456789'.repeat(16);
const UNKNOWN_TEXT = '合成SDK发送未知';
const UNKNOWN_REPLY = 'SDK_UNKNOWN_ORIGINAL_RESULT';
const OTHER_TEXT = '合成SDK另一聊天';
const OTHER_REPLY = 'SDK_OTHER_CHAT_RESULT';
const FIRST_TEXT = '合成SDK原聊天唯一成果';
const FIRST_REPLY = 'SDK_FIRST_CHAT_RESULT';
const STARTED_TEXT = '合成SDK执行中崩溃';
const INBOX_CONTEXT = 'synthetic-inbox-context:原始消息';
const ACK_REPLY = '[reliability-node] Synthetic reliability session\n\n合成任务已保存；请以本轮持久回执核对进度。';
const CHUNK_CHARS = 64;
const runtimeProvenanceCache = new Map();
const hash = value => createHash('sha256').update(value).digest('hex');
const text = message => message.item_list?.[0]?.text_item?.text ?? '';
const key = (chatId, messageId) => JSON.stringify([ACCOUNT, chatId, messageId]);
const sdk = options => ({ leaderMode: 'codex', sdkModelOptions: options });
const workspace = (h, chatId) => join(h.gatewayOptions.leaderRoot, hash(JSON.stringify([ACCOUNT, chatId])));
const nativeThreadId = async (h, chatId) => JSON.parse(await readFile(join(workspace(h, chatId), '.thread.json'), 'utf8')).threadId;

async function journal(h, chatId, messageId) {
  const entries = JSON.parse(await readFile(join(workspace(h, chatId), '.replies.json'), 'utf8'));
  const entry = entries[hash(messageId)];
  assert(entry, 'Original stable SDK message disappeared from its reply journal');
  h.evidence('sdk-journal-observed', { chatId, messageId, entry });
  return entry;
}

async function runtimeProvenance(executable) {
  const identity = info => JSON.stringify([info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs]);
  const before = identity(await stat(executable)), cached = runtimeProvenanceCache.get(executable);
  if (cached?.identity === before) return cached.provenance;
  const digest = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(executable)) { digest.update(chunk); bytes += chunk.length; }
  assert.equal(identity(await stat(executable)), before, 'Native executable changed while recording provenance');
  const provenance = { executable, sha256: digest.digest('hex'), bytes,
    platform: process.platform, arch: process.arch, transport: 'app-server',
    nativeExecutableReplaced: false };
  runtimeProvenanceCache.set(executable, { identity: before, provenance });
  return provenance;
}

async function nativeExecutions(h) {
  const records = await h.wechat.readSdkProcesses();
  assert(!records.some(item => ['error', 'rpc-audit-error'].includes(item.event)), JSON.stringify(records));
  const executions = records.filter(item => item.event === 'spawn');
  assert(executions.every(item => item.pid && item.transport === 'app-server' && /[/\\]codex(?:\.exe)?$/.test(item.executable)));
  const starts = records.filter(item => item.event === 'rpc-request' && item.method === 'turn/start');
  assert.equal(starts.length, executions.length, 'Each native app-server query must start exactly one turn');
  assert(executions.every(item => starts.filter(start => start.pid === item.pid).length === 1),
    'Native app-server turn/start ownership did not match its recorded process');
  const mcp = records.filter(item => item.event === 'rpc-notification' && item.method === 'mcpServer/startupStatus/updated');
  for (const execution of executions) {
    const startup = mcp.filter(item => item.pid === execution.pid);
    assert(startup.length > 0, 'Native MCP startup evidence is missing');
    assert(startup.every(item => item.serverName === 'wechat_control'), 'Unexpected external MCP server started');
    const threadId = starts.find(item => item.pid === execution.pid).params.threadId;
    assert.equal(typeof threadId, 'string');
    assert(startup.every(item => item.threadId === threadId), 'MCP startup belongs to another native thread');
    assert(startup.every(item => item.error === null && item.failureReason === null), 'MCP startup reported an error');
    assert.equal(startup.at(-1).status, 'ready', 'Local control MCP never became ready');
    assert(!startup.some(item => ['failed', 'cancelled'].includes(item.status)), 'Local control MCP startup failed');
  }
  if (executions.length && !h.sdkRuntimeRecorded) {
    h.evidence('sdk-runtime-provenance', await runtimeProvenance(executions[0].executable));
    h.sdkRuntimeRecorded = true;
  }
  h.evidence('sdk-native-processes', { records });
  h.evidence('sdk-mcp-startup-observed', { startup: mcp });
  return executions;
}

export const sdkScenarios = [
  ['sdk-durable-inbox-cursor-crash-recovery', async h => {
    const initialCursor = (await h.wechat.readState()).sync_buf;
    const createdAtMs = Date.now() - 1_000;
    const message = h.wechat.enqueue(TASK, { chatId: CHAT, contextToken: INBOX_CONTEXT, createdAtMs });
    const originalKey = key(CHAT, message.client_id);
    const expected = { chatId: CHAT, text: TASK, messageId: message.client_id, deliveryKey: originalKey,
      contextToken: INBOX_CONTEXT, createdAtMs };
    const committedCursor = `synthetic-cursor-${h.wechat.incoming.length}`;
    let authorizations = 0;
    const hold = h.control.holdHttp(entry => entry.method === 'POST' && entry.path === '/v1/chats/authorize' &&
      entry.body?.chatId === CHAT && ++authorizations === 2);
    const options = { ...h.gatewayOptions, mode: '--run', auditInbox: true };
    const first = h.wechat.start(options);
    const authorization = await h.entered(hold.entered, 'inbox admitted; native execution authorization held');
    assert.equal(authorization.status, 200);
    assert.equal(JSON.parse(authorization.response).allowed, true);
    await waitFor(async () => {
      h.healthy(); return (await h.wechat.readState()).sync_buf === committedCursor;
    }, 'poll cursor committed while execution remains blocked');
    assert.equal(first.child.exitCode, null); assert.equal(first.child.signalCode, null);
    assert.equal(authorizations, 2);
    assert.deepEqual((await h.wechat.readInbox()).items, [expected]);
    const audit = await h.wechat.readInboxAudit();
    const admission = audit.find(item => item.pid === first.child.pid && item.target === 'inbox' &&
      item.inbox.value?.items.some(value => value.deliveryKey === originalKey));
    const commit = audit.find(item => item.pid === first.child.pid && item.cursorChanged && item.cursor === committedCursor);
    assert(admission && commit, 'Missing actual inbox/cursor rename checkpoints');
    assert(admission.sequence < commit.sequence, 'Cursor committed before durable inbox');
    assert.equal(admission.state.value.sync_buf, initialCursor);
    assert.deepEqual(admission.inbox.value.items, [expected]);
    assert.deepEqual(commit.inbox.value.items, [expected]);
    assert.equal((await nativeExecutions(h)).length, 0);
    assert.equal(h.sdkModel.calls.length, 0); assert.equal(h.model.calls.length, 0);
    assert.equal(h.native.starts.length, 0); assert.equal(h.wechat.sent.length, 0);
    await assert.rejects(readFile(join(workspace(h, CHAT), '.replies.json')), error => error.code === 'ENOENT');
    const beforeCrash = await h.wechat.readState();
    assert.equal(beforeCrash.delivery_outbox[originalKey], undefined);
    assert.equal(beforeCrash.reply_deliveries[originalKey], undefined);
    h.evidence('sdk-inbox-pre-crash-checkpoint', { expected, initialCursor, committedCursor,
      pid: first.child.pid, admission, commit, audit, authorizations,
      nativeExecutions: 0, sdkModelCalls: 0, controllerModelCalls: 0, targetStarts: 0, sends: 0 });
    const crash = await h.wechat.kill(first);
    assert.equal(crash.signal, 'SIGKILL');
    assert.equal((await nativeExecutions(h)).length, 0);
    assert.equal(h.sdkModel.calls.length, 0); assert.equal(h.model.calls.length, 0);
    assert.equal(h.control.requests.filter(item => item.method === 'POST' && item.path === '/v1/chats/authorize' &&
      item.body?.chatId === CHAT).length, 2, 'Execution authorization barrier expired before the crash');
    await assert.rejects(readFile(join(workspace(h, CHAT), '.replies.json')), error => error.code === 'ENOENT');
    hold.release();
    assert.deepEqual((await h.wechat.readInbox()).items, [expected]);

    const recoveryPollStart = h.wechat.polls.length;
    const source = h.wechat.holdPoll();
    const recovered = h.wechat.start(options);
    const emptyPoll = await h.entered(source.entered, 'restarted run reads the committed source cursor');
    assert.deepEqual(emptyPoll, { cursor: committedCursor, count: 0 }); source.release();
    await waitFor(async () => {
      h.healthy();
      const state = await h.wechat.readState();
      return (await h.wechat.readInbox()).items.length === 0 &&
        state.delivery_outbox[originalKey] === undefined && h.wechat.sent.some(item => text(item) === ACK_REPLY);
    }, 'disk inbox recovered and native reply acknowledged');
    assert.equal((await journal(h, CHAT, message.client_id)).stage, 'completed');
    assert.equal((await journal(h, CHAT, message.client_id)).delivery, 'accepted');
    assert.equal((await nativeExecutions(h)).length, 1);
    const submissions = h.control.requests.filter(item => item.method === 'POST' && item.path === '/v1/messages');
    assert.equal(submissions.length, 1);
    assert.deepEqual(submissions[0].body, { chatId: CHAT, messageId: message.client_id, text: TASK });
    const stored = await h.pool.query('SELECT chat_id, message_id, text FROM messages');
    assert.equal(stored.rowCount, 1);
    assert.deepEqual(stored.rows[0], { chat_id: CHAT, message_id: message.client_id, text: TASK });
    const commands = await h.pool.query('SELECT command_id FROM commands');
    assert.equal(commands.rowCount, 1); await h.native.waitForStarts(1);
    assert.equal(h.wechat.sent.length, 1); assert.equal(text(h.wechat.sent[0]), ACK_REPLY);
    assert.equal(h.wechat.sent[0].to_user_id, CHAT); assert.equal(h.wechat.sent[0].context_token, INBOX_CONTEXT);
    await h.wechat.stop(recovered);
    const restartAudit = await h.wechat.readInboxAudit();
    const startup = restartAudit.find(item => item.pid === recovered.child.pid && item.operation === 'startup');
    assert(startup, 'Missing restart disk snapshot');
    assert.deepEqual(startup.inbox.value.items, [expected]); assert.equal(startup.cursor, committedCursor);
    const sourcePolls = h.wechat.polls.slice(recoveryPollStart);
    assert(sourcePolls.length > 0);
    assert(sourcePolls.every(item => item.cursor === committedCursor && item.count === 0), 'Recovery used source replay');
    assert.equal(h.wechat.incoming.length, 1);
    h.evidence('sdk-inbox-recovered', { expected, startup, sourcePolls, restartAudit, submissions: submissions.map(item => item.body) });

    await h.complete(commands.rows[0].command_id);
    const delivery = await h.waitResult();
    assert.equal(delivery.chatId, CHAT);
    const modelCalls = h.sdkModel.calls.length, controllerCalls = h.model.calls.length;
    const finalPollStart = h.wechat.polls.length;
    const final = h.wechat.start(options);
    await waitFor(async () => {
      h.healthy(); return (await h.delivery(delivery.id)).status === 'accepted' && h.wechat.polls.length > finalPollStart;
    }, 'final result delivered after another real run restart');
    const finals = h.wechat.sent.filter(item => text(item).includes(TASK_RESULT));
    assert.equal(finals.length, 1); assert.equal(finals[0].to_user_id, CHAT);
    assert.equal(finals[0].context_token, INBOX_CONTEXT); assert.equal(h.wechat.sent.length, 2);
    assert.equal((await nativeExecutions(h)).length, 1);
    assert.equal(h.sdkModel.calls.length, modelCalls); assert.equal(h.model.calls.length, controllerCalls);
    assert.equal(h.native.starts.length, 1); assert.equal(h.wechat.incoming.length, 1);
    assert(h.wechat.polls.slice(finalPollStart).every(item => item.cursor === committedCursor && item.count === 0));
    const replayPollStart = h.wechat.polls.length;
    h.wechat.enqueue(TASK, { id: message.client_id, chatId: CHAT, contextToken: INBOX_CONTEXT, createdAtMs });
    const replayCursor = `synthetic-cursor-${h.wechat.incoming.length}`;
    await waitFor(async () => {
      h.healthy(); return (await h.wechat.readState()).sync_buf === replayCursor && (await h.wechat.readInbox()).items.length === 0;
    }, 'real run discards stable message replay after completed recovery');
    await h.wechat.stop(final);
    assert.equal((await nativeExecutions(h)).length, 1);
    assert.equal(h.sdkModel.calls.length, modelCalls); assert.equal(h.model.calls.length, controllerCalls);
    assert.equal(h.native.starts.length, 1); assert.equal(h.wechat.sent.length, 2);
    assert.equal(h.control.requests.filter(item => item.method === 'POST' && item.path === '/v1/messages').length, 1);
    assert.equal((await h.pool.query('SELECT command_id FROM commands')).rowCount, 1);
    const replayPolls = h.wechat.polls.slice(replayPollStart);
    assert.equal(replayPolls.filter(item => item.count === 1 && item.cursor === committedCursor).length, 1);
    assert.deepEqual((await h.wechat.readInbox()).items, []);
    h.evidence('sdk-inbox-final-audit', { records: await h.wechat.readInboxAudit(), replayPolls });
    h.evidence('assertions', { leaderMode: 'codex', realRunLoop: true, inboxBeforeCursor: true,
      crashBoundary: 'cursor committed; native and model not started', originalInboxTupleRestored: true,
      recoverySourceReplays: 0, completedSourceReplays: 1, nativeExecutions: 1, controllerSubmissions: 1, messages: 1, commands: 1,
      targetStarts: 1, acknowledgedReplies: 1, finalMessages: 1, correctChatAndContext: true,
      receipt: 'accepted', duplicateExecutions: 0 });
  }, sdk({ control: true, reply: ACK_REPLY })],
  ['sdk-started-turn-crash-no-blind-retry', async h => {
    const hold = h.sdkModel.holdNextResponse();
    const message = h.wechat.enqueue(STARTED_TEXT, { chatId: CHAT });
    const running = h.wechat.start({ ...h.gatewayOptions, mode: '--poll-once' });
    const request = await h.entered(hold.entered, 'real native Codex waiting for model with durable started intent');
    assert.equal(currentSdkUserText(request), STARTED_TEXT);
    const pending = await journal(h, CHAT, message.client_id);
    assert.equal(pending.stage, 'started'); assert.equal(pending.delivery, 'pending');
    const executions = await nativeExecutions(h);
    assert.equal(executions.length, 1);
    await h.wechat.kill(running); hold.release();
    for (const execution of executions) {
      assert.throws(() => process.kill(execution.pid, 0), error => error.code === 'ESRCH',
        'Killed Gateway left its owned native Codex process running');
    }
    h.wechat.enqueue(STARTED_TEXT, { chatId: CHAT, id: message.client_id });
    assert.equal((await h.poll()).code, 0);
    assert.equal((await nativeExecutions(h)).length, 1, 'Unknown native SDK turn was blindly rerun');
    assert.equal(h.sdkModel.calls.length, 1);
    const recovered = await journal(h, CHAT, message.client_id);
    assert.equal(recovered.stage, 'started', 'Uncompleted native turn was promoted to completed');
    assert.equal(recovered.delivery, 'accepted');
    assert.equal(h.wechat.sent.length, 1);
    assert(text(h.wechat.sent[0]).includes('结果尚不明确'));
    assert.equal(h.wechat.sent[0].to_user_id, CHAT);
    assert.equal(h.native.starts.length, 0);
    const sent = h.wechat.sent.length;
    assert.equal((await h.poll()).code, 0); assert.equal(h.wechat.sent.length, sent);
    assert.equal((await nativeExecutions(h)).length, 1);
    h.evidence('assertions', { leaderMode: 'codex', durableBeforeCrash: 'started/pending', nativeExecutions: 1,
      originalNativePidsRemoved: true, recoveredNativeOutcome: 'unknown', automaticReruns: 0,
      recoveredJournalStage: 'started', uncertaintyNoticeDelivery: 'accepted', fakeCompletion: false });
  }, sdk({})],
  ['sdk-inbound-replay-controller-outage', async h => {
    await h.control.crash();
    const message = h.wechat.enqueue(TASK, { chatId: CHAT });
    const before = await h.wechat.readState();
    const disconnected = await h.poll();
    assert.notEqual(disconnected.code, 0);
    assert.equal((await h.wechat.readState()).sync_buf, before.sync_buf);
    assert.equal((await nativeExecutions(h)).length, 0, 'Unavailable authorization still ran the SDK');
    await h.control.start(); await h.waitNode(true);
    const fault = h.control.failHttp(entry => entry.path === '/v1/messages' && entry.method === 'POST');
    const processed = await h.poll();
    assert.equal(processed.code, 0, processed.stderr);
    assert.equal((await h.entered(fault.entered, 'SDK MCP Controller commit')).status, 200);
    await h.native.waitForStarts(1);
    assert.equal((await nativeExecutions(h)).length, 1);
    const uncertain = await journal(h, CHAT, message.client_id);
    assert.equal(uncertain.stage, 'started', 'Lost Controller stream was promoted to a completed native outcome');
    assert.equal(uncertain.delivery, 'accepted');
    assert(h.wechat.sent.some(item => item.to_user_id === CHAT && text(item).includes('执行结果待核实')));
    const requests = h.control.requests.filter(item => item.path === '/v1/messages' && item.method === 'POST');
    assert.equal(requests.length, 1, 'Ambiguous Controller stream was blindly submitted again');
    for (const request of requests) assert.deepEqual(request.body, { chatId: CHAT, messageId: message.client_id, text: TASK });
    const stored = await h.pool.query('SELECT message_id FROM messages WHERE chat_id=$1 AND message_id=$2', [CHAT, message.client_id]);
    assert.equal(stored.rowCount, 1);
    const commands = await h.pool.query('SELECT command_id FROM commands');
    assert.equal(commands.rowCount, 1);
    const sdkCalls = h.sdkModel.calls.length, controllerCalls = h.model.calls.length, sends = h.wechat.sent.length;
    h.wechat.enqueue(TASK, { chatId: CHAT, id: message.client_id });
    assert.equal((await h.poll()).code, 0);
    assert.equal((await nativeExecutions(h)).length, 1);
    assert.equal(h.sdkModel.calls.length, sdkCalls);
    assert.equal(h.model.calls.length, controllerCalls);
    assert.equal(h.wechat.sent.length, sends);
    await h.complete(commands.rows[0].command_id);
    const delivery = await h.waitResult();
    assert.equal(delivery.chatId, CHAT);
    assert.equal((await h.poll()).code, 0);
    const finals = h.wechat.sent.filter(item => text(item).includes(TASK_RESULT));
    assert.equal(finals.length, 1); assert.equal(finals[0].to_user_id, CHAT);
    assert.equal(finals[0].context_token, `synthetic-context:${CHAT}`);
    assert.equal((await h.delivery(delivery.id)).status, 'accepted');
    assert.equal(h.native.starts.length, 1);
    h.evidence('assertions', { leaderMode: 'codex', realNativeExecutions: 1, retainedOfflineCursor: true,
      originalMcpRequestPreserved: true, httpAttempts: requests.length, messages: 1, commands: 1,
      unknownControllerStreamNotRetried: true, recoveredJournalStage: 'started',
      targetStarts: 1, finalMessages: 1, correctChat: true, duplicateModelCalls: 0 });
  }, sdk({ control: true })],
  ['sdk-persisted-reply-restart-recovery', async h => {
    const message = h.wechat.enqueue(SAFE_TEXT, { chatId: CHAT });
    const originalKey = key(CHAT, message.client_id);
    const barrier = h.wechat.holdPoll({ afterPolls: h.wechat.polls.length + 2 });
    const running = h.wechat.start({ ...h.gatewayOptions, mode: '--run', sendBudget: 1, maxChars: CHUNK_CHARS });
    await h.entered(barrier.entered, 'native reply polling isolated behind the owned HTTP barrier');
    await waitFor(async () => {
      h.healthy();
      const state = await h.wechat.readState(), delivery = state.reply_deliveries[originalKey];
      return delivery?.acknowledgedChunks === 1 && delivery.inFlight === false &&
        state.delivery_outbox[originalKey]?.source === 'engine';
    }, 'native completed reply and acknowledged first chunk persisted before crash');
    const persisted = await journal(h, CHAT, message.client_id);
    const state = await h.wechat.readState();
    assert.equal(persisted.stage, 'completed'); assert.equal(persisted.delivery, 'pending');
    assert.equal(persisted.reply.text, SAFE_REPLY);
    assert.equal(state.delivery_outbox[originalKey].source, 'engine');
    assert.equal(state.delivery_outbox[originalKey].status, 'pending');
    assert.equal(state.delivery_outbox[originalKey].splitMaxChars, CHUNK_CHARS);
    assert.equal(state.reply_deliveries[originalKey].acknowledgedChunks, 1);
    assert.equal(state.reply_deliveries[originalKey].inFlight, false);
    assert.equal(h.wechat.sent.length, 1);
    assert.equal(text(h.wechat.sent[0]), SAFE_REPLY.slice(0, CHUNK_CHARS));
    assert.equal((await nativeExecutions(h)).length, 1);
    const originalThreadId = await nativeThreadId(h, CHAT);
    await h.wechat.kill(running); barrier.drop();
    h.wechat.enqueue(SAFE_TEXT, { chatId: CHAT, id: message.client_id });
    assert.equal((await h.poll({ sendBudget: 100, maxChars: 7 })).code, 0);
    assert.equal(h.wechat.sent.length, 1, 'Replay or larger configured ceiling renewed exhausted send permission');
    assert.equal((await nativeExecutions(h)).length, 1, 'Persisted SDK result reran its native turn');
    const renewal = h.wechat.enqueue(RENEW_TEXT, { chatId: CHAT });
    assert.equal((await h.poll({ sendBudget: 100, maxChars: 1000 })).code, 0);
    assert.equal((await journal(h, CHAT, renewal.client_id)).stage, 'completed');
    assert.equal(h.wechat.sent.filter(item => text(item) === RENEW_REPLY).length, 1);
    assert.equal(await nativeThreadId(h, CHAT), originalThreadId, 'True inbound abandoned the saved native SDK thread');
    const nativeRecords = await h.wechat.readSdkProcesses();
    const requests = nativeRecords.filter(item => item.event === 'rpc-request');
    const resumes = requests.filter(item => item.method === 'thread/resume');
    assert.equal(resumes.length, 1); assert.equal(resumes[0].params.threadId, originalThreadId);
    const resumed = nativeRecords.filter(item => item.event === 'rpc-response' && item.method === 'thread/resume');
    assert.equal(resumed.length, 1); assert.equal(resumed[0].resultThreadId, originalThreadId);
    assert.equal(requests.filter(item => item.method === 'thread/start').length, 1);
    const chunks = h.wechat.sent.filter(item => text(item) !== RENEW_REPLY);
    assert.equal(chunks.map(text).join(''), SAFE_REPLY, 'Restart changed or dropped the frozen SDK reply');
    assert.equal(chunks.length, Math.ceil(SAFE_REPLY.length / CHUNK_CHARS));
    assert(chunks.slice(0, -1).every(item => text(item).length === CHUNK_CHARS), 'Restart changed frozen chunk boundaries');
    assert(chunks.every(item => item.to_user_id === CHAT && item.context_token === `synthetic-context:${CHAT}`));
    assert.equal((await journal(h, CHAT, message.client_id)).delivery, 'accepted');
    assert.equal((await h.wechat.readState()).delivery_outbox[originalKey], undefined);
    assert.equal((await nativeExecutions(h)).length, 2, 'Only the true new inbound may start the next native turn');
    assert.equal(h.control.requests.filter(item => item.path === '/v1/messages').length, 0);
    const before = h.wechat.sent.length;
    assert.equal((await h.poll()).code, 0); assert.equal(h.wechat.sent.length, before);
    h.evidence('assertions', { leaderMode: 'codex', durableBeforeCrash: 'completed/pending', source: 'engine',
      safeCheckpoint: { acknowledgedChunks: 1, inFlight: false }, originalNativeExecutions: 1,
      trueNewInboundExecutions: 1, duplicateNativeExecutions: 0, exactReplyRestored: true,
      savedNativeThreadResumed: true, frozenChunkBoundaries: true, finalReceipt: 'accepted', controllerPostFallbacks: 0 });
  }, sdk({ reply: body => currentSdkUserText(body) === SAFE_TEXT ? SAFE_REPLY : RENEW_REPLY })],
  ['sdk-unknown-send-no-blind-retry', async h => {
    const message = h.wechat.enqueue(UNKNOWN_TEXT, { chatId: CHAT });
    const send = h.wechat.nextSendFault('hold');
    const running = h.wechat.start({ ...h.gatewayOptions, mode: '--poll-once' });
    await h.entered(send.entered, 'real SDK reply reached HTTPS send without acknowledgement');
    const originalKey = key(CHAT, message.client_id);
    assert.equal((await journal(h, CHAT, message.client_id)).stage, 'completed');
    assert.equal((await h.wechat.readState()).reply_deliveries[originalKey].inFlight, true);
    assert.equal((await nativeExecutions(h)).length, 1);
    await h.wechat.kill(running); send.drop();
    h.wechat.enqueue(UNKNOWN_TEXT, { chatId: CHAT, id: message.client_id });
    assert.equal((await h.poll()).code, 0);
    assert.equal((await journal(h, CHAT, message.client_id)).delivery, 'uncertain');
    assert.equal((await h.wechat.readState()).delivery_outbox[originalKey].status, 'uncertain');
    assert.equal((await nativeExecutions(h)).length, 1);
    h.wechat.enqueue(OTHER_TEXT, { chatId: OTHER_CHAT });
    assert.equal((await h.poll()).code, 0);
    assert.equal((await nativeExecutions(h)).length, 2);
    assert.notEqual(await nativeThreadId(h, CHAT), await nativeThreadId(h, OTHER_CHAT), 'Independent chats reused one native thread');
    assert.equal(h.wechat.sent.filter(item => text(item) === UNKNOWN_REPLY).length, 1);
    assert.equal(h.wechat.sent.filter(item => text(item) === OTHER_REPLY && item.to_user_id === OTHER_CHAT).length, 1);
    assert.equal((await journal(h, CHAT, message.client_id)).delivery, 'uncertain');
    const before = h.wechat.sent.length;
    assert.equal((await h.poll()).code, 0); assert.equal(h.wechat.sent.length, before);
    h.evidence('assertions', { leaderMode: 'codex', unknownSends: 1, resends: 0, originalNativeExecutions: 1,
      journal: 'uncertain', evidencePreserved: true, otherChatProgresses: true, phoneReceiptProven: false });
  }, sdk({ reply: body => currentSdkUserText(body) === UNKNOWN_TEXT ? UNKNOWN_REPLY : OTHER_REPLY })],
  ['sdk-two-chat-result-ownership', async h => {
    const first = h.wechat.enqueue(FIRST_TEXT, { chatId: CHAT });
    h.wechat.enqueue(OTHER_TEXT, { chatId: OTHER_CHAT, id: first.client_id });
    assert.equal((await h.poll()).code, 0);
    assert.equal((await nativeExecutions(h)).length, 2);
    assert.notEqual(await nativeThreadId(h, CHAT), await nativeThreadId(h, OTHER_CHAT),
      'Independent chats shared one native app-server thread');
    for (const [chatId, expected] of [[CHAT, FIRST_REPLY], [OTHER_CHAT, OTHER_REPLY]]) {
      const sent = h.wechat.sent.filter(item => item.to_user_id === chatId);
      assert.equal(sent.length, 1); assert.equal(text(sent[0]), expected);
      assert.equal(sent[0].context_token, `synthetic-context:${chatId}`);
      const entry = await journal(h, chatId, first.client_id);
      assert.equal(entry.reply.text, expected); assert.equal(entry.delivery, 'accepted');
    }
    h.wechat.enqueue(FIRST_TEXT, { chatId: CHAT, id: first.client_id });
    h.wechat.enqueue(OTHER_TEXT, { chatId: OTHER_CHAT, id: first.client_id });
    assert.equal((await h.poll()).code, 0);
    assert.equal((await nativeExecutions(h)).length, 2); assert.equal(h.wechat.sent.length, 2);
    assert.equal(h.control.requests.filter(item => item.path === '/v1/messages').length, 0);
    h.evidence('assertions', { leaderMode: 'codex', sameSourceIdAcrossChats: true, distinctPerChatJournals: true,
      exactReplies: true, correctChatAndContext: true, nativeExecutions: 2, duplicateNativeExecutions: 0, duplicateSends: 0 });
  }, sdk({ reply: body => currentSdkUserText(body) === FIRST_TEXT ? FIRST_REPLY : OTHER_REPLY })],
];
