import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const MAX_SNAPSHOTS = 32;
const REQUEST_TIMEOUT_MS = 5000;
const PLAN_FIELDS = ['createdAt', 'expiresAt', 'id', 'status', 'steps'];
const STEP_FIELDS = new Set(['step', 'nodeId', 'sessionId', 'prompt', 'promptTruncated', 'dependsOn', 'resultFrom', 'resultSources', 'status', 'commandId', 'turnId']);
const SOURCE_FIELDS = ['commandId', 'excerptLength', 'outputLength', 'outputSHA256', 'step', 'truncated', 'turnId'];

// Uses the actual console cookie and HTTP/SSE handlers of the temporary Controller.
// No live credentials, browser session or external channel is involved.
export async function openPlanConsoleProbe({ base, request, waitFor }) {
  const issued = await request('/v1/console-links', { requestId: 'plan-console-' + randomUUID() });
  assert.equal(issued.status, 200);
  const token = new URLSearchParams(new URL(issued.body.url).hash.slice(1)).get('login');
  assert(token, 'Temporary console link omitted its credential');
  const exchange = await fetch(base + '/auth/exchange', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ token }), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  assert.equal(exchange.status, 200);
  const cookie = exchange.headers.get('set-cookie')?.split(';')[0];
  assert(cookie, 'Temporary console exchange omitted cookie');
  await exchange.arrayBuffer();
  const get = (path, init = {}) => fetch(base + path, { ...init,
    headers: { cookie, origin: base, ...init.headers }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  for (const path of ['/v1/messages', '/v1/commands']) {
    const denied = await get(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(denied.status, 401, 'Plan visibility widened console write authority');
    await denied.arrayBuffer();
  }

  const abort = new AbortController();
  let reader, reading, finished = false, revoked = false;
  const snapshots = [], errors = [];
  try {
    const headerDeadline = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(base + '/v1/events', { headers: { cookie, origin: base }, signal: abort.signal });
    } finally { clearTimeout(headerDeadline); }
    assert.equal(response.status, 200);
    reader = response.body.getReader();
    reading = (async () => {
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let end;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            if (frame.startsWith('event: auth-expired\n')) revoked = true;
            if (!frame.startsWith('event: status\n')) continue;
            const line = frame.split('\n').find(item => item.startsWith('data: '));
            assert(line, 'Status event has no JSON data');
            const snapshot = JSON.parse(line.slice(6));
            assertProjection(snapshot.executions);
            snapshots.push(snapshot.executions);
            if (snapshots.length > MAX_SNAPSHOTS) snapshots.shift();
          }
        }
      } catch (error) {
        if (!abort.signal.aborted) errors.push(error);
      } finally { finished = true; }
    })();
    await waitFor(() => { if (errors.length) throw errors[0]; return snapshots.length > 0; }, 'Authenticated console initial plan SSE');
  } catch (error) {
    abort.abort();
    if (reading) await reading;
    throw error;
  }
  return {
    async assertRecordedPrompt(commandId, prompt) {
      const detail = await get('/v1/commands/' + encodeURIComponent(commandId));
      assert.equal(detail.status, 200);
      assert.equal((await detail.json()).prompt, prompt);
      const response = await get('/v1/status');
      assert.equal(response.status, 200);
      const status = await response.json();
      assert.equal(status.commands.find(command => command.commandId === commandId)?.prompt, prompt);
    },
    async assertPlan(id, expectedStatus, expectedSteps) {
      let plan;
      // HTTP may join an SSE snapshot already in flight before the durable state changed.
      await waitFor(async () => {
        if (errors.length) throw errors[0];
        const response = await get('/v1/status');
        assert.equal(response.status, 200);
        const group = (await response.json()).executions;
        assertProjection(group);
        plan = group.items.find(item => item.id === id);
        return plan?.status === expectedStatus &&
          JSON.stringify(plan.steps.map(step => step.status)) === JSON.stringify(expectedSteps);
      }, `Console HTTP plan ${id} becomes ${expectedStatus} with exact steps ${JSON.stringify(expectedSteps)}`);
      assert(plan, 'Confirmed execution missing from authenticated console');
      assert.equal(plan.status, expectedStatus);
      assert.deepEqual(plan.steps.map(step => step.status), expectedSteps);
      await waitFor(() => {
        if (errors.length) throw errors[0];
        assert(!finished, 'Plan SSE closed before its expected update');
        return snapshots.some(snapshot => snapshot.items.some(item => item.id === id && JSON.stringify(item) === JSON.stringify(plan)));
      }, 'SSE has the same exact plan projection as HTTP');
      return plan;
    },
    async assertAbsent(id) {
      const response = await get('/v1/status');
      assert.equal(response.status, 200);
      const group = (await response.json()).executions;
      assertProjection(group);
      assert(!group.items.some(item => item.id === id), 'Unconfirmed plan leaked into execution console');
      assert(!snapshots.some(snapshot => snapshot.items.some(item => item.id === id)), 'SSE published an unconfirmed execution');
    },
    async revoke() {
      const response = await get('/auth/logout', { method: 'POST' });
      assert.equal(response.status, 200);
      await response.arrayBuffer();
      await waitFor(() => { if (errors.length) throw errors[0]; return finished && revoked; }, 'Console revocation closes plan SSE');
      const denied = await get('/v1/status');
      assert.equal(denied.status, 401, 'Revoked cookie can still read plans');
      await denied.arrayBuffer();
    },
    async close() {
      abort.abort();
      await reading;
      reader.releaseLock();
      if (errors.length) throw errors[0];
    },
  };
}

export function assertProjection(group) {
  assert(group && typeof group === 'object');
  assert.deepEqual(Object.keys(group).sort(), ['hasMore', 'items', 'limit', 'observedAt']);
  assert.equal(group.limit, 12);
  assert.equal(typeof group.hasMore, 'boolean');
  assert(Number.isSafeInteger(group.observedAt));
  assert(Array.isArray(group.items) && group.items.length <= group.limit);
  for (const plan of group.items) {
    assert.deepEqual(Object.keys(plan).sort(), PLAN_FIELDS);
    assert(plan.steps.length >= 1 && plan.steps.length <= 4);
    for (const step of plan.steps) {
      assert(Object.keys(step).every(key => STEP_FIELDS.has(key)), 'Private execution fields leaked to the console');
      assert([...step.prompt].length <= 512);
      assert.equal(typeof step.promptTruncated, 'boolean');
      assert(Array.isArray(step.resultFrom), 'Result sharing policy missing from console');
      for (const source of step.resultSources ?? []) {
        assert.deepEqual(Object.keys(source).sort(), SOURCE_FIELDS, 'Raw source input leaked to console');
        assert(step.resultFrom.includes(source.step));
      }
    }
  }
}
