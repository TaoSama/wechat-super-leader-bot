import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import test from 'node:test';
import { verificationEnvironment } from '../../../scripts/verify.mjs';
import { withTestCleanup } from '../../support/cleanup.mjs';
import { createControllerFixture, createPostgresFixture, waitFor } from '../../support/control-plane-fixture.mjs';
import { verifyPlanExecution, planModelCall, PLAN_CHAT, PLAN_NODE } from './plan-execution.mjs';
import { verifyGoals, goalModelCall, GOAL_CHAT, GOAL_NODE } from './goals.mjs';

const SCENARIO_TIMEOUT_MS = 180_000;
const MODEL_API_KEY = 'non-secret-scenario-test-key';

// pnpm --dir controller build && node --test tests/integration/leader/plan-execution.test.mjs
// verifyPlanExecution opens the real cookie-authenticated HTTP/SSE console probe.
function defineScenario({ title, nodeId, chatId, verify, modelCall }) {
test(title, {
  timeout: SCENARIO_TIMEOUT_MS,
}, async context => {
  const env = verificationEnvironment();
  const postgres = createPostgresFixture({ env });
  const token = randomBytes(24).toString('hex');
  const nodeToken = randomBytes(24).toString('hex');
  const secrets = [postgres.password, token, nodeToken, MODEL_API_KEY];
  const logs = [];
  const modelErrors = [];
  let controller, store;
  const redact = value => {
    let text = String(value);
    for (const secret of secrets) text = text.replaceAll(secret, '[redacted]');
    return text.replace(/postgres(?:ql)?:\/\/[^\s]+/gu, '[redacted-database-url]')
      .replace(/Bearer\s+[^\s"']+/giu, 'Bearer [redacted]')
      .replace(/(#login=)[^\s"']+/gu, '$1[redacted]');
  };
  const model = createServer(async (request, response) => {
    try {
      let body = '';
      for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body);
      const last = payload.input.at(-1);
      let output;
      if (last.type === 'function_call_output') {
        output = [{ type: 'message', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: `Tool evidence: ${last.output}` }] }];
      } else {
        const call = modelCall(last, payload.tools);
        assert(call, 'Scenario model fixture received an unsupported request');
        output = [{ type: 'function_call', call_id: `fixture-${call.name}`, name: call.name,
          arguments: JSON.stringify(call.args) }];
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'completed', output }));
    } catch (error) {
      modelErrors.push(error.name);
      response.writeHead(500);
      response.end('Synthetic scenario model fixture failed');
    }
  });
  try {
    await withTestCleanup(async () => {
      const databaseUrl = await postgres.start();
      secrets.push(databaseUrl);
      model.listen(0, '127.0.0.1');
      await once(model, 'listening');
      controller = await createControllerFixture({ logs, secrets, env: {
        ...env, PERSISTENCE_MODE: 'postgres', DATABASE_URL: databaseUrl,
        CONTROLLER_TOKEN: token, NODE_TOKENS: JSON.stringify({ [nodeId]: nodeToken }),
        ALLOWED_CHAT_IDS: [chatId, 'test-chat'].join(','), LEADER_MODE: 'model',
        LEADER_MODEL_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`,
        LEADER_MODEL_NAME: 'local-scenario-fixture-only', LEADER_MODEL_API_KEY: MODEL_API_KEY,
      } });
      await controller.start();
      const require = createRequire(new URL('../../../controller/package.json', import.meta.url));
      const { WebSocket } = require('ws');
      const { PostgresStore } = await import('../../../controller/dist/store/postgres.js');
      // Controller owns initialization; opening an observer must not reset active work.
      store = new PostgresStore(databaseUrl);
      const restart = async (allowed = true) => {
        await controller.stop();
        controller.env.ALLOWED_CHAT_IDS = allowed ? [chatId, 'test-chat'].join(',') : 'test-chat';
        await controller.start();
      };
      await verify({ WebSocket, base: controller.base, request: controller.request,
        nodeToken, store, restart, waitFor });
      assert.deepEqual(modelErrors, [], 'Scenario model fixture received an unexpected request');
    }, [
      { label: 'scenario Controller', cleanup: () => controller?.stop() },
      { label: 'scenario model', cleanup: () => model.listening
        ? new Promise((resolve, reject) => model.close(error => error ? reject(error) : resolve())) : undefined },
      { label: 'scenario PostgreSQL store pool', cleanup: () => store?.close() },
      { label: 'scenario PostgreSQL container', cleanup: () => postgres.stop() },
    ]);
  } catch (error) {
    context.diagnostic(`Controller logs (redacted):\n${redact(logs.join(''))}`);
    throw new Error(redact(error.stack ?? error));
  }
});
}

defineScenario({ title: 'persistent plan execution and console SSE with isolated PostgreSQL, model and node fixtures',
  nodeId: PLAN_NODE, chatId: PLAN_CHAT, verify: verifyPlanExecution, modelCall: last => planModelCall(last.content) });
defineScenario({ title: 'persistent goal execution and console SSE with isolated PostgreSQL, model and node fixtures',
  nodeId: GOAL_NODE, chatId: GOAL_CHAT, verify: verifyGoals, modelCall: goalModelCall });
