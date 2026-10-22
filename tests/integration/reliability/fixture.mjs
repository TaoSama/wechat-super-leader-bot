import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { verificationEnvironment } from '../../../scripts/verify.mjs';
import { withTestCleanup } from '../../support/cleanup.mjs';
import { waitFor } from '../../support/control-plane-fixture.mjs';
import { createControlFixture } from '../../support/reliability-control.mjs';
import { createModelFixture, CHAT, OTHER_CHAT, NODE, SESSION, TASK, TASK_RESULT } from '../../support/reliability-model.mjs';
import { createNativeFixture } from '../../support/reliability-native.mjs';
import { createWechatFixture } from '../../support/reliability-wechat.mjs';
import { createSdkModelFixture } from '../../support/reliability-sdk-model.mjs';

const require = createRequire(new URL('../../../controller/package.json', import.meta.url));
const { Pool } = require('pg');
export { Pool, CHAT, OTHER_CHAT, NODE, SESSION, TASK, TASK_RESULT, delay, waitFor };
export const OBSERVE_MS = 2_200;

export async function withReliabilityFixture({ databaseUrl, evidence, name, signal,
  leaderMode = 'controller', sdkModelOptions = {} }, operation) {
  // /tmp deliberately keeps the Unix socket below macOS's 104-byte limit.
  const dir = await mkdtemp('/tmp/slr-');
  const cleanup = [];
  const registerCleanup = (label, operation) => cleanup.unshift({ label, cleanup: async () => {
    try { await operation(); }
    catch (error) { evidence('scenario-cleanup-failure', { resource: label, message: error.message }); throw error; }
  } });
  registerCleanup('temporary files', () => rm(dir, { recursive: true, force: true }));
  let control, native, wechat, pool;
  await withTestCleanup(async () => {
    const env = verificationEnvironment();
    pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000, query_timeout: 10_000 });
    registerCleanup('SQL observer', () => pool.end());
    const model = await createModelFixture({ evidence });
    registerCleanup('model server', () => model.stop());
    const sdkModel = leaderMode === 'codex' ? await createSdkModelFixture({ evidence, ...sdkModelOptions }) : undefined;
    if (sdkModel) registerCleanup('SDK model server', () => sdkModel.stop());
    const token = randomUUID(), nodeToken = randomUUID();
    control = await createControlFixture({ env, databaseUrl, token, nodeToken, nodeId: NODE,
      chatIds: [CHAT, OTHER_CHAT], modelUrl: model.url, evidence, commandTtlSeconds: name === 'offline-expiry' ? 5 : 60 });
    registerCleanup('Controller and owned proxy', () => control.stop());
    await control.start();
    signal?.throwIfAborted();
    native = createNativeFixture({ dir: join(dir, 'native'), env,
      controllerUrl: control.proxyUrl.replace('http:', 'ws:') + '/v1/daemon', nodeId: NODE, nodeToken, sessionId: SESSION, evidence });
    registerCleanup('Go Daemon and native shim', () => native.stop());
    await native.start();
    signal?.throwIfAborted();
    wechat = await createWechatFixture({ dir: join(dir, 'wechat'), env, evidence: item => evidence('wechat', item) });
    registerCleanup('Gateway and WeChat shim', () => wechat.close());
    const healthy = () => { signal?.throwIfAborted(); control.healthy(); native.healthy(); wechat.healthy(); model.healthy(); sdkModel?.healthy(); };
    const gatewayOptions = { controllerUrl: control.proxyUrl, controllerToken: token,
      ...(sdkModel ? { leaderMode, leaderRoot: join(await realpath(dir), 'leader'), leaderModel: sdkModel.model,
        sdkBaseUrl: sdkModel.url, sdkApiKey: sdkModel.apiKey } : {}) };
    const command = async id => {
      const response = await control.request('/v1/commands/' + id);
      assert.equal(response.status, 200, JSON.stringify(response));
      return response.body;
    };
    const h = { dir, control, native, wechat, model, sdkModel, pool, healthy, gatewayOptions, evidence,
      async poll(options) {
        const result = await wechat.runOnce({ ...gatewayOptions, ...options });
        evidence('gateway-process-output', result);
        return result;
      }, command,
      entered: (promise, label) => atBarrier(promise, label, signal),
      async session() {
        const response = await control.request('/v1/status');
        assert.equal(response.status, 200);
        return response.body.sessions.find(item => item.nodeId === NODE && item.id === native.sessionId);
      },
      async waitSession(status = 'idle') {
        await waitFor(async () => { healthy(); return (await h.session())?.status === status; }, 'native session ' + status);
      },
      async waitNode(connected) {
        await waitFor(async () => {
          healthy();
          const response = await control.request('/v1/status');
          return response.body.nodes.some(item => item.nodeId === NODE && item.connected) === connected;
        }, 'Daemon connected=' + connected);
      },
      async submit(prompt, requestId = randomUUID()) {
        return control.request('/v1/commands', { nodeId: NODE, sessionId: native.sessionId, action: 'send', prompt, requestId });
      },
      async waitCommand(id, status) {
        await waitFor(async () => { healthy(); return (await command(id)).status === status; }, `command ${id} ${status}`);
        const record = await command(id);
        evidence('command-observed', { record });
        return record;
      },
      async complete(id, output = TASK_RESULT) {
        const receipt = await h.waitCommand(id, 'accepted');
        native.complete(receipt.turnId, output);
        const result = await h.waitCommand(id, 'completed');
        assert.equal(result.turnId, receipt.turnId);
        assert.equal(result.nodeId, NODE); assert.equal(result.sessionId, native.sessionId); assert.equal(result.output, output);
        return result;
      },
      async launchTask({ notifications = false } = {}) {
        const message = wechat.enqueue(TASK, { chatId: CHAT });
        const result = await h.poll({ notifications });
        assert.equal(result.code, 0, result.stderr);
        await native.waitForStarts(1);
        const rows = await pool.query('SELECT command_id FROM commands WHERE action=$1', ['send']);
        assert.equal(rows.rowCount, 1);
        return { id: rows.rows[0].command_id, message };
      },
      async pending() {
        const response = await control.request('/v1/deliveries/pending', { chatIds: [CHAT, OTHER_CHAT] });
        assert.equal(response.status, 200);
        return response.body.items;
      },
      async waitResult() {
        let result;
        await waitFor(async () => { healthy(); result = (await h.pending()).find(item => item.source.type === 'plan'); return !!result; }, 'durable task result');
        evidence('result-observed', { result });
        return result;
      },
      async delivery(id) { return (await control.request('/v1/deliveries/' + id)).body.delivery; },
    };
    await h.waitSession();
    try { await operation(h); healthy(); }
    finally {
      const tables = ['commands', 'leader_executions', 'result_deliveries'];
      for (const table of tables) {
        const rows = await pool.query(`SELECT to_jsonb(t) AS record FROM ${table} t`);
        evidence('database-snapshot', { name, table, records: rows.rows.map(item => item.record) });
      }
      const state = JSON.parse(await readFile(wechat.statePath, 'utf8'));
      evidence('gateway-snapshot', { state });
      for (const running of wechat.processes) evidence('gateway-process-output', {
        pid: running.child.pid, stdout: running.stdout, stderr: running.stderr,
        code: running.child.exitCode, signal: running.child.signalCode });
      if (sdkModel) evidence('sdk-process-snapshot', { processes: await wechat.readSdkProcesses() });
      evidence('native-snapshot', { starts: native.starts, resumes: native.resumes, turns: native.turns });
    }
  }, cleanup);
}

async function atBarrier(promise, label, signal) {
  let timer, onAbort;
  try {
    signal?.throwIfAborted();
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out at fault barrier: ' + label)), 25_000); });
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    return await Promise.race([promise, timeout, aborted]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export async function writeReport(directory, summary, events) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  await writeFile(join(directory, 'events.jsonl'), events.map(item => JSON.stringify(item)).join('\n') + '\n');
}
