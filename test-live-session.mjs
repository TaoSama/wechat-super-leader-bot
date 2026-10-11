import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const configPath = fileURLToPath(new URL('./.runtime/local.json', import.meta.url));

const { values } = parseArgs({
  options: {
    help: { type: 'boolean', short: 'h' },
    controller: { type: 'string', default: 'http://127.0.0.1:8790' },
    session: { type: 'string' },
    node: { type: 'string', default: 'macair' },
    timeout: { type: 'string', default: '60000' },
    pollInterval: { type: 'string', default: '500' },
  },
});

if (values.help) {
  console.log(`Usage: node test-live-session.mjs --session <sessionId> [options]

Options:
  --session <id>        Required. Target session ID to test (must be idle and support send).
  --node <id>           Target node ID (default: "macair").
  --controller <url>    Controller base URL (default: "http://127.0.0.1:8790").
  --timeout <ms>        Max timeout in milliseconds for command completion (default: 60000).
  --pollInterval <ms>   Interval between polling checks in milliseconds (default: 500).
  -h, --help            Show this help message.
`);
  process.exit(0);
}

await main().catch((error) => {
  console.error(`FAILED: ${error.message}`);
  process.exitCode = 1;
});

async function main() {
  if (!values.session || typeof values.session !== 'string' || !values.session.trim()) {
    throw new Error('Missing required option: --session <sessionId>');
  }
  const targetSessionId = values.session.trim();
  const targetNodeId = values.node.trim();

  // Strict Number validation for timeout and pollInterval
  const timeoutMs = Number(values.timeout);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Invalid --timeout '${values.timeout}': must be a positive integer`);
  }
  const pollIntervalMs = Number(values.pollInterval);
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error(`Invalid --pollInterval '${values.pollInterval}': must be a positive integer`);
  }

  // 1. Controller URL validation
  const base = new URL(values.controller);
  assert(!base.username && !base.password && !base.search && !base.hash && !/[?#]/.test(values.controller), 'Controller URL must not contain credentials, query parameters, or fragments');
  assert(base.protocol === 'https:' || (base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)), 'Remote Controller requires HTTPS');

  // 2. Read local.json without echoing credentials
  let token = process.env.CONTROLLER_TOKEN;
  if (!token) {
    try {
      const metadata = await stat(configPath);
      if ((metadata.mode & 0o077) !== 0) {
        throw new Error('Private configuration must not be accessible by group or others (expected 0600)');
      }
      const raw = await readFile(configPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (typeof parsed.controllerToken === 'string' && /^[a-f0-9]{64}$/.test(parsed.controllerToken)) {
        token = parsed.controllerToken;
      }
    } catch (err) {
      throw new Error(`Failed to read Controller token from ${configPath}: ${err.message}`);
    }
  }
  if (!token) {
    throw new Error('CONTROLLER_TOKEN is missing or invalid in .runtime/local.json');
  }

  const authedFetch = async (path, options = {}) => {
    const res = await fetch(new URL(path, base), {
      ...options,
      redirect: 'error',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(options.headers || {}),
      },
      signal: AbortSignal.timeout(15000),
    });
    return res;
  };

  // 3. Check Controller health & status
  const healthRes = await fetch(new URL('/health', base), { redirect: 'error', signal: AbortSignal.timeout(5000) });
  assert(healthRes.ok, `Controller /health returned HTTP ${healthRes.status}`);

  const statusRes = await authedFetch('/v1/status');
  assert(statusRes.ok, `Controller /v1/status returned HTTP ${statusRes.status}`);
  const statusData = await statusRes.json();
  assert(Array.isArray(statusData.sessions), 'Controller /v1/status missing sessions array');
  assert(Array.isArray(statusData.nodes), 'Controller /v1/status missing nodes array');

  const nodeObj = statusData.nodes.find((n) => n.nodeId === targetNodeId);
  assert(nodeObj, `Node '${targetNodeId}' not registered in Controller status`);
  assert(nodeObj.connected, `Node '${targetNodeId}' is currently disconnected`);

  const sessionObj = statusData.sessions.find((s) => s.nodeId === targetNodeId && s.id === targetSessionId);
  assert(sessionObj, `Session '${targetSessionId}' on node '${targetNodeId}' not found in Controller status`);
  console.log(JSON.stringify({
    step: 'session_check',
    nodeId: targetNodeId,
    sessionId: targetSessionId,
    title: sessionObj.title,
    status: sessionObj.status,
    capabilities: sessionObj.capabilities,
  }, null, 2));

  assert.equal(sessionObj.status, 'idle', `Session status must be 'idle' before sending, got '${sessionObj.status}'`);
  assert(sessionObj.capabilities.includes('send'), `Session does not advertise 'send' capability: ${JSON.stringify(sessionObj.capabilities)}`);

  // 4. Construct fixed zero-side-effect marker task
  const marker = `LIVE_HARNESS_MARKER_${randomUUID()}`;
  const prompt = `请仅回复包含纯文本 ${marker} 的一句话，不要执行任何工具或创建文件。`;
  const requestId = `req_live_${randomUUID()}`;

  console.log(JSON.stringify({
    step: 'submit_command',
    requestId,
    marker,
    action: 'send',
  }, null, 2));

  const postPayload = {
    nodeId: targetNodeId,
    sessionId: targetSessionId,
    action: 'send',
    prompt,
    requestId,
  };

  const submitRes = await authedFetch('/v1/commands', {
    method: 'POST',
    body: JSON.stringify(postPayload),
  });
  assert([200, 201, 202].includes(submitRes.status), `Submit /v1/commands returned HTTP ${submitRes.status}`);
  const submitData = await submitRes.json();
  const commandId = submitData.commandId;
  assert(commandId, 'Submit /v1/commands did not return commandId');

  console.log(JSON.stringify({
    step: 'command_submitted',
    commandId,
    initialStatus: submitData.status,
  }, null, 2));

  // 5. Test idempotency: send exact same requestId and payload again
  const duplicateRes = await authedFetch('/v1/commands', {
    method: 'POST',
    body: JSON.stringify(postPayload),
  });
  assert([200, 201, 202].includes(duplicateRes.status), `Duplicate submit returned HTTP ${duplicateRes.status}`);
  const duplicateData = await duplicateRes.json();
  assert.equal(duplicateData.commandId, commandId, `Idempotency violation: duplicate submit returned different commandId '${duplicateData.commandId}' vs '${commandId}'`);
  console.log(JSON.stringify({
    step: 'idempotency_verified',
    commandId,
    reused: true,
  }, null, 2));

  // 6. Poll for exact terminal status (completed)
  const deadline = Date.now() + timeoutMs;
  let finalRecord = null;
  while (Date.now() < deadline) {
    const pollRes = await authedFetch(`/v1/commands/${encodeURIComponent(commandId)}`);
    assert(pollRes.ok, `Poll /v1/commands/${commandId} returned HTTP ${pollRes.status}`);
    const record = await pollRes.json();

    if (['completed', 'failed', 'uncertain'].includes(record.status)) {
      finalRecord = record;
      break;
    }
    await delay(pollIntervalMs);
  }

  assert(finalRecord, `Command ${commandId} did not reach terminal status within ${timeoutMs}ms`);
  console.log(JSON.stringify({
    step: 'terminal_reached',
    commandId,
    status: finalRecord.status,
    turnId: finalRecord.turnId,
    outputLength: finalRecord.output ? finalRecord.output.length : 0,
    error: finalRecord.error,
  }, null, 2));

  assert.equal(finalRecord.status, 'completed', `Command finished with non-completed status: ${finalRecord.status} (error: ${finalRecord.error})`);
  assert.equal(finalRecord.nodeId, targetNodeId, `Command nodeId mismatch: expected '${targetNodeId}', got '${finalRecord.nodeId}'`);
  assert.equal(finalRecord.sessionId, targetSessionId, `Command sessionId mismatch: expected '${targetSessionId}', got '${finalRecord.sessionId}'`);
  assert(finalRecord.turnId, 'Completed send command must have turnId bound');
  assert(typeof finalRecord.output === 'string' && finalRecord.output.includes(marker), `Output did not contain marker '${marker}'. Output was: ${finalRecord.output}`);

  // 7. Test idempotency again after completion: assert HTTP status and consistency of commandId, turnId, and status
  const postCompletedDupRes = await authedFetch('/v1/commands', {
    method: 'POST',
    body: JSON.stringify(postPayload),
  });
  assert([200, 201, 202].includes(postCompletedDupRes.status), `Post-completion duplicate submit returned HTTP ${postCompletedDupRes.status}`);
  const postCompletedDupData = await postCompletedDupRes.json();
  assert.equal(postCompletedDupData.commandId, commandId, 'Idempotency after completion violated: commandId mismatch');
  assert.equal(postCompletedDupData.status, 'completed', 'Idempotency after completion violated: status mismatch');
  assert.equal(postCompletedDupData.turnId, finalRecord.turnId, 'Idempotency after completion violated: turnId mismatch');

  console.log(JSON.stringify({
    step: 'harness_success',
    commandId,
    turnId: finalRecord.turnId,
    markerVerified: true,
  }, null, 2));

  console.log('PASS test-live-session completed all assertions.');
}
