import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const script = new URL('../../../scripts/analyze-message-latency.mjs', import.meta.url);
const event = (stage, fields = {}) => ({ schema: 1, event: 'message_latency', service: 'gateway', traceId: 'trace-one',
  attemptId: 'gateway-one', timestamp: '2026-10-21T01:00:00Z', elapsedMs: 0, stage, ...fields });
const run = (events, args = []) => spawnSync(process.execPath, [script.pathname, ...args], {
  input: events.map(item => typeof item === 'string' ? item : JSON.stringify(item)).join('\n'), encoding: 'utf8',
});
const json = (events, args = []) => {
  const result = run(events, ['--json', ...args]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};

test('reads timestamp-prefixed Docker lines, counts malformed JSON, ignores normal logs and poll traces', () => {
  const report = json(['gateway started', '{broken', '{"event":"other"}',
    `2026-10-21T01:00:00Z ${JSON.stringify(event('message.received', { platformToReceivedMs: 100 }))}`,
    event('wechat.poll.end', { traceId: 'poll-trace', durationMs: 1000 }), event('message.processing.start', { batchWaitMs: 20 }),
    event('message.processing.end', { elapsedMs: 50, outcome: 'processed' }),
    event('message.received', { schema: 2 })]);
  assert.equal(report.totalAttempts, 1);
  assert.deepEqual(report.diagnostics, { lines: 8, ordinaryLines: 2, malformedJsonLines: 1, invalidEvents: 1 });
  assert.equal(report.attempts[0].timings.platformToReceivedMs, 100);
  assert.equal(report.attempts[0].timings.batchWaitMs, 20);
  assert.equal(report.attempts[0].timings.receivedToProcessingEndMs, 50);
});

test('does not let empty polls with nested getupdates HTTP spans consume the latest-message limit', () => {
  const polls = Array.from({ length: 25 }, (_, index) => {
    const fields = { traceId: `poll-${index}`, attemptId: `poll-attempt-${index}`,
      timestamp: '2026-10-21T03:00:00Z' };
    return [event('wechat.poll.start', fields),
      event('wechat.http.start', { ...fields, purpose: 'getupdates' }),
      event('wechat.http.headers', { ...fields, purpose: 'getupdates', httpStatus: 200, durationMs: 30000 }),
      event('wechat.http.end', { ...fields, purpose: 'getupdates', outcome: 'ok', durationMs: 30010 }),
      event('wechat.poll.end', { ...fields, outcome: 'ok', durationMs: 30015 })];
  }).flat();
  const report = json([event('message.received'), ...polls], ['--limit', '1']);
  assert.equal(report.totalAttempts, 1);
  assert.equal(report.shownAttempts, 1);
  assert.equal(report.attempts[0].traceId, 'trace-one');
  assert.equal(report.attempts[0].stages.some(stage => stage.stage.startsWith('wechat.poll')), false);
  const onlyPolls = json(polls);
  assert.equal(onlyPolls.totalAttempts, 0);
  assert.deepEqual(onlyPolls.attempts, []);
});

test('joins controller parent attempts without summing retries or overlapping stages into a total', () => {
  const controller = fields => ({ service: 'controller', attemptId: 'controller-one', parentAttemptId: 'gateway-one', ...fields });
  const report = json([
    event('controller.received', controller({})),
    event('model.complete.end', controller({ durationMs: 400 })),
    event('model.http.attempt.end', controller({ durationMs: 100, attempt: 1, outcome: 'error' })),
    event('model.http.attempt.end', controller({ durationMs: 200, attempt: 2, outcome: 'ok' })),
    event('leader.tool.end', controller({ durationMs: 30, tool: 'list_sessions' })),
    event('message.received', { platformToReceivedMs: 15 }),
    event('controller.http.end', { durationMs: 500 }),
    event('codex.stream.first_event', { firstEventMs: 2 }),
    event('codex.stream.first_agent_message', { firstAgentMessageMs: 30 }),
    event('codex.stream.drained', { durationMs: 600, streamDrainMs: 5 }),
    event('message.leader.end', { durationMs: 610 }),
    event('wechat.chunk.accepted', { elapsedMs: 700 }),
    event('delivery.end', { durationMs: 90, receiptStatus: 'wechat_api_accepted' }),
    event('message.processing.end', { elapsedMs: 710, outcome: 'processed' }),
    event('message.received', { attemptId: 'gateway-two', timestamp: '2026-10-21T02:00:00Z' }),
    event('message.processing.end', { attemptId: 'gateway-two', elapsedMs: 25, outcome: 'error', timestamp: '2026-10-21T02:00:00Z' }),
  ]);
  assert.equal(report.totalAttempts, 2);
  const first = report.attempts.find(attempt => attempt.gatewayAttemptId === 'gateway-one');
  assert.deepEqual(first.controllers[0].modelHttpAttemptMs, [100, 200]);
  assert.deepEqual(first.controllers[0].modelCompletionMs, [400]);
  assert.deepEqual(first.controllers[0].toolsMs, [30]);
  assert.deepEqual(first.controllers[0].stages.find(stage => stage.stage === 'leader.tool.end').tools, ['list_sessions']);
  assert.deepEqual(first.controllers[0].stages.find(stage => stage.stage === 'model.http.attempt.end').attempts, [1, 2]);
  assert.equal(first.timings.receivedToApiAcceptedMs, 700);
  assert.equal(first.timings.platformToApiAcceptedMs, 715);
  assert.equal(first.timings.sdkFirstEventMs, 2);
  assert.equal(first.timings.modelTtftMs, 'unknown');
  assert.equal(first.failedStages.length, 1);
  assert.equal(report.attempts[0].timings.receivedToProcessingEndMs, 25);
  assert.equal(report.attempts[0].timings.platformToApiAcceptedMs, 'unknown');
});

test('keeps recovery-only attempts and orphan controller attempts explicit with unknown missing ingress', () => {
  const report = json([
    event('delivery.start'), event('wechat.reply.reused'),
    event('delivery.end', { durationMs: 10, receiptStatus: 'wechat_api_accepted' }),
    event('controller.message.end', { service: 'controller', attemptId: 'orphan', traceId: 'other-trace', parentAttemptId: 'missing-parent', durationMs: 5, outcome: 'error' }),
  ]);
  const recovery = report.attempts.find(attempt => attempt.gatewayAttemptId === 'gateway-one');
  assert.equal(recovery.deliveryOnlyAttempt, true);
  assert.equal(recovery.receiptReused, true);
  assert.equal(recovery.timings.receivedToApiAcceptedMs, 'unknown');
  const orphan = report.attempts.find(attempt => attempt.traceId === 'other-trace');
  assert.equal(orphan.gatewayAttemptId, 'unknown');
  assert.equal(orphan.parentAttemptId, 'missing-parent');
  assert.equal(orphan.controllers[0].outcome, 'error');
});

test('preserves clock skew and never turns a negative platform interval into end-to-end latency', () => {
  const report = json([event('message.received', { platformToReceivedMs: -100, clockSkew: true }),
    event('wechat.send.accepted', { elapsedMs: 30 }), event('delivery.end', { receiptStatus: 'wechat_api_accepted' })]);
  assert.equal(report.attempts[0].timings.platformToReceivedMs, -100);
  assert.equal(report.attempts[0].timings.platformToApiAcceptedMs, 'unknown');
});

test('does not report an accepted first chunk as acceptance of an incomplete whole reply', () => {
  const report = json([event('message.received', { platformToReceivedMs: 100 }),
    event('wechat.chunk.accepted', { elapsedMs: 30, chunkIndex: 0, chunkCount: 2 }),
    event('wechat.chunk.failed', { chunkIndex: 1, chunkCount: 2 }),
    event('delivery.end', { receiptStatus: 'error', durationMs: 40 })]);
  assert.equal(report.attempts[0].timings.receivedToApiAcceptedMs, 'unknown');
  assert.equal(report.attempts[0].timings.platformToApiAcceptedMs, 'unknown');
  assert.equal(report.attempts[0].failedStages[0].stage, 'wechat.chunk.failed');
});

test('supports input files, trace filtering, latest-attempt limits, human output and standard help', t => {
  const root = mkdtempSync(join(tmpdir(), 'message-latency-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = join(root, 'events.log');
  writeFileSync(input, Array.from({ length: 22 }, (_, index) => JSON.stringify(event('message.received', {
    traceId: `trace-${index}`, timestamp: new Date(Date.UTC(2026, 9, 21, 0, 0, index)).toISOString(),
  }))).join('\n'));
  const latest = json([], ['--input', input]);
  assert.equal(latest.totalAttempts, 22);
  assert.equal(latest.shownAttempts, 20);
  assert.equal(latest.attempts[0].traceId, 'trace-21');
  const filtered = json([], ['--input', input, '--trace-id', 'trace-1', '--limit', '1']);
  assert.equal(filtered.totalAttempts, 1);
  const text = run([event('message.received')]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /不是模型 TTFT/u);
  assert.match(text.stdout, /不代表手机实收/u);
  for (const flag of ['--help', '-h']) assert.match(run([], [flag]).stdout, /Usage:/u);
  for (const args of [['--limit', '0'], ['--limit', '1.5'], ['--unknown'], ['--input', join(root, 'missing')]]) {
    const result = run([], args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /analyze-message-latency:/u);
  }
});
