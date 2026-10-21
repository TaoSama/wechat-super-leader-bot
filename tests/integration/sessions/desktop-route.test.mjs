import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { verificationEnvironment } from '../../../scripts/verify.mjs';
import { withTestCleanup } from '../../support/cleanup.mjs';
import { createControllerFixture, createPostgresFixture, waitFor } from '../../support/control-plane-fixture.mjs';
import { createDesktopModelFixture, verifyDesktopRoute } from './desktop-route.mjs';

const DESKTOP_NODE_ID = 'desktop-fixture-node';
const SCENARIO_TIMEOUT_MS = 150_000;

// Run this scenario independently with:
// pnpm --dir controller build && node --test tests/integration/sessions/desktop-route.test.mjs
// All model responses, desktop sockets, sessions and PostgreSQL data are fixtures.
test('original desktop owner: large snapshots, exact receipts, busy changes and ordered skills', {
  timeout: SCENARIO_TIMEOUT_MS,
}, async () => {
  const env = verificationEnvironment();
  const postgres = createPostgresFixture({ env });
  const token = randomBytes(24).toString('hex');
  const nodeToken = randomBytes(24).toString('hex');
  const modelErrors = [];
  const desktopModel = createDesktopModelFixture();
  let controller;
  const model = createServer(async (request, response) => {
    try {
      let body = '';
      for await (const chunk of request) body += chunk;
      const last = JSON.parse(body).input.at(-1);
      const message = desktopModel.respond(last);
      assert(message, 'Synthetic desktop model received an unexpected request');
      const output = message.tool_calls
        ? message.tool_calls.map(call => ({ type: 'function_call', call_id: call.id,
          name: call.function.name, arguments: call.function.arguments }))
        : [{ type: 'message', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: message.content }] }];
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'completed', output }));
    } catch (error) {
      modelErrors.push(error);
      response.writeHead(500);
      response.end('Synthetic model fixture failed');
    }
  });
  await withTestCleanup(async () => {
    const databaseUrl = await postgres.start();
    model.listen(0, '127.0.0.1');
    await once(model, 'listening');
    controller = await createControllerFixture({ secrets: [postgres.password, token, nodeToken], env: {
      ...env, PERSISTENCE_MODE: 'postgres', DATABASE_URL: databaseUrl,
      CONTROLLER_TOKEN: token, NODE_TOKENS: JSON.stringify({ [DESKTOP_NODE_ID]: nodeToken }),
      ALLOWED_CHAT_IDS: 'test-chat', LEADER_MODE: 'model',
      LEADER_MODEL_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`,
      LEADER_MODEL_NAME: 'local-fixture-only', LEADER_MODEL_API_KEY: 'non-secret-test-key',
    } });
    await controller.start();
    await verifyDesktopRoute({ base: controller.base, request: controller.request, nodeToken, waitFor, modelEvidence: desktopModel.outputs });
    assert.deepEqual(modelErrors, [], 'Synthetic model received an unexpected request');
  }, [
    { label: 'desktop scenario Controller', cleanup: () => controller?.stop() },
    { label: 'desktop scenario model', cleanup: () => model.listening
      ? new Promise((resolve, reject) => model.close(error => error ? reject(error) : resolve())) : undefined },
    { label: 'desktop scenario PostgreSQL', cleanup: () => postgres.stop() },
  ]);
});
