#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const UNKNOWN = 'unknown';
const DEFAULT_LIMIT = 20;
const HELP = `Usage: node scripts/analyze-message-latency.mjs [options]
Read message_latency JSON lines from Docker logs; omit --input to read stdin.
  --input <path>       Input log file
  --trace-id <id>      Filter an exact trace ID
  --limit <number>     Latest message attempts (default: 20)
  --json              Emit structured JSON
  --help, -h          Show help

Durations are observed service wall times. Stages overlap and must not be summed
as end-to-end latency. API acceptance is not receipt on the user's phone.
first_event and first_agent_message are SDK observations, not model TTFT.
`;

const finite = value => typeof value === 'number' && Number.isFinite(value);
const first = (events, stage) => events.find(event => event.stage === stage);
const last = (events, stage) => events.findLast(event => event.stage === stage);
const durations = (events, stage) => events.filter(event => event.stage === stage && finite(event.durationMs)).map(event => event.durationMs);
const elapsedBetween = (start, end) => start && end && finite(start.elapsedMs) && finite(end.elapsedMs) && end.elapsedMs >= start.elapsedMs
  ? end.elapsedMs - start.elapsedMs : UNKNOWN;
const durationValue = (events, stage) => {
  const values = durations(events, stage);
  return values.length ? values : UNKNOWN;
};

function parseLog(input) {
  const events = [];
  const diagnostics = { lines: 0, ordinaryLines: 0, malformedJsonLines: 0, invalidEvents: 0 };
  for (const line of input.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    diagnostics.lines++;
    const objectStart = line.indexOf('{');
    if (objectStart < 0) { diagnostics.ordinaryLines++; continue; }
    let event;
    try { event = JSON.parse(line.slice(objectStart)); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      diagnostics.malformedJsonLines++;
      continue;
    }
    if (event?.event !== 'message_latency') { diagnostics.ordinaryLines++; continue; }
    if (event.schema !== 1 || !['gateway', 'controller'].includes(event.service) ||
      !['traceId', 'attemptId', 'stage'].every(field => typeof event[field] === 'string' && event[field])) {
      diagnostics.invalidEvents++;
      continue;
    }
    events.push(event);
  }
  return { events, diagnostics };
}

function stageSummary(events) {
  const stages = new Map();
  for (const event of events) {
    const summary = stages.get(event.stage) ?? { stage: event.stage, count: 0, durationsMs: [], outcomes: [], statuses: [], tools: [], attempts: [] };
    summary.count++;
    if (finite(event.durationMs)) summary.durationsMs.push(event.durationMs);
    if (typeof event.outcome === 'string') summary.outcomes.push(event.outcome);
    if (typeof event.receiptStatus === 'string') summary.statuses.push(event.receiptStatus);
    if (typeof event.httpStatus === 'number') summary.statuses.push(event.httpStatus);
    if (typeof event.tool === 'string') summary.tools.push(event.tool);
    if (finite(event.attempt)) summary.attempts.push(event.attempt);
    stages.set(event.stage, summary);
  }
  return [...stages.values()].map(stage => ({ ...stage, durationsMs: stage.durationsMs.length ? stage.durationsMs : UNKNOWN }));
}

function summarize(group) {
  const events = group.gateway;
  const received = first(events, 'message.received');
  const processing = last(events, 'message.processing.end');
  const delivery = last(events, 'delivery.end');
  // An accepted early chunk does not establish acceptance of the entire reply.
  const accepted = delivery?.receiptStatus === 'wechat_api_accepted'
    ? last(events, 'wechat.chunk.accepted') ?? last(events, 'wechat.send.accepted') : undefined;
  const receivedToAccepted = elapsedBetween(received, accepted);
  const platformDelay = received && finite(received.platformToReceivedMs) ? received.platformToReceivedMs : UNKNOWN;
  const validPlatformDelay = finite(platformDelay) && platformDelay >= 0 && received.clockSkew !== true;
  const failedStages = [...events, ...group.controllers.flatMap(controller => controller.events)]
    .filter(event => event.outcome === 'error' || event.failed === true || event.aborted === true ||
      /(?:\.failed|\.failure|\.interrupted|\.incomplete|\.rejected)$/u.test(event.stage))
    .map(event => ({ service: event.service, attemptId: event.attemptId, stage: event.stage }));
  const lastTimestamp = [...events, ...group.controllers.flatMap(controller => controller.events)]
    .map(event => event.timestamp).filter(value => typeof value === 'string' && Number.isFinite(Date.parse(value))).sort().at(-1) ?? UNKNOWN;
  return {
    traceId: group.traceId, gatewayAttemptId: group.gatewayAttemptId ?? UNKNOWN,
    parentAttemptId: group.parentAttemptId ?? UNKNOWN, lastTimestamp,
    outcome: processing?.outcome ?? delivery?.receiptStatus ?? UNKNOWN,
    deliveryReceipt: delivery?.receiptStatus ?? UNKNOWN,
    receiptReused: events.some(event => ['wechat.reply.reused', 'codex.journal.reused'].includes(event.stage)),
    deliveryOnlyAttempt: !received && events.some(event => event.stage === 'delivery.start'),
    nativeThreadResumed: events.some(event => event.stage === 'codex.thread.selected' && event.recovery === true),
    clockSkew: received?.clockSkew ?? UNKNOWN,
    batch: { id: received?.batchId ?? UNKNOWN, index: received?.batchIndex ?? UNKNOWN, count: received?.batchCount ?? UNKNOWN },
    timings: {
      platformToReceivedMs: platformDelay,
      batchWaitMs: first(events, 'message.processing.start')?.batchWaitMs ?? UNKNOWN,
      receivedToProcessingEndMs: elapsedBetween(received, processing),
      receivedToApiAcceptedMs: receivedToAccepted,
      platformToApiAcceptedMs: validPlatformDelay && finite(receivedToAccepted) ? platformDelay + receivedToAccepted : UNKNOWN,
      leaderMs: durationValue(events, 'message.leader.end'),
      controllerRequestMs: durationValue(events, 'controller.http.end'),
      nativeStreamMs: durationValue(events, 'codex.stream.drained'),
      nativeTurnObservedMs: durationValue(events, 'codex.turn.completed'),
      nativeStreamDrainMs: last(events, 'codex.stream.drained')?.streamDrainMs ?? UNKNOWN,
      sdkFirstEventMs: first(events, 'codex.stream.first_event')?.firstEventMs ?? UNKNOWN,
      sdkFirstAgentMessageMs: first(events, 'codex.stream.first_agent_message')?.firstAgentMessageMs ?? UNKNOWN,
      modelTtftMs: UNKNOWN,
      deliveryMs: durationValue(events, 'delivery.end'),
    },
    failedStages,
    stages: stageSummary(events),
    controllers: group.controllers.map(controller => ({ attemptId: controller.attemptId,
      parentAttemptId: controller.parentAttemptId ?? UNKNOWN,
      outcome: last(controller.events, 'controller.message.end')?.outcome ?? UNKNOWN,
      modelCompletionMs: durationValue(controller.events, 'model.complete.end'),
      modelHttpAttemptMs: durationValue(controller.events, 'model.http.attempt.end'),
      toolsMs: durationValue(controller.events, 'leader.tool.end'), stages: stageSummary(controller.events) })),
  };
}

function analyze(events, traceId, limit) {
  const gateways = new Map();
  const controllers = new Map();
  for (const event of events) {
    if (traceId && event.traceId !== traceId) continue;
    const key = JSON.stringify([event.traceId, event.attemptId]);
    const map = event.service === 'gateway' ? gateways : controllers;
    const list = map.get(key) ?? [];
    list.push(event);
    map.set(key, list);
  }
  const groups = new Map();
  for (const [key, gateway] of gateways) {
    // Generic wechat.http events also occur inside synthetic long-poll traces.
    // Require a message lifecycle signal rather than treating every non-poll span as a message.
    if (!gateway.some(event => /^(?:message|delivery|codex|controller\.http|wechat\.(?:reply|chunk|send))\./u.test(event.stage))) continue;
    groups.set(key, { traceId: gateway[0].traceId, gatewayAttemptId: gateway[0].attemptId, gateway, controllers: [] });
  }
  for (const controllerEvents of controllers.values()) {
    const controller = { attemptId: controllerEvents[0].attemptId,
      parentAttemptId: controllerEvents.find(event => event.parentAttemptId)?.parentAttemptId,
      events: controllerEvents };
    const key = JSON.stringify([controllerEvents[0].traceId, controller.parentAttemptId ?? controller.attemptId]);
    const group = groups.get(key) ?? { traceId: controllerEvents[0].traceId,
      parentAttemptId: controller.parentAttemptId, gateway: [], controllers: [] };
    group.controllers.push(controller);
    groups.set(key, group);
  }
  const attempts = [...groups.values()].map(summarize).sort((a, b) => (Date.parse(b.lastTimestamp) || 0) - (Date.parse(a.lastTimestamp) || 0));
  return { totalAttempts: attempts.length, shownAttempts: Math.min(limit, attempts.length), attempts: attempts.slice(0, limit) };
}

function textReport(report) {
  const lines = [`消息延迟：展示 ${report.shownAttempts}/${report.totalAttempts} 个独立处理尝试`,
    `普通日志 ${report.diagnostics.ordinaryLines}；畸形 JSON ${report.diagnostics.malformedJsonLines}；无效事件 ${report.diagnostics.invalidEvents}`];
  for (const attempt of report.attempts) {
    lines.push(`\ntrace=${attempt.traceId} gatewayAttempt=${attempt.gatewayAttemptId} outcome=${attempt.outcome} receipt=${attempt.deliveryReceipt}`,
      `batch=${JSON.stringify(attempt.batch)} deliveryOnly=${attempt.deliveryOnlyAttempt} receiptReused=${attempt.receiptReused}`,
      `timings=${JSON.stringify(attempt.timings)}`);
    for (const stage of attempt.stages) lines.push(`  gateway ${stage.stage} count=${stage.count} durationsMs=${JSON.stringify(stage.durationsMs)} outcomes=${JSON.stringify(stage.outcomes)} statuses=${JSON.stringify(stage.statuses)} attempts=${JSON.stringify(stage.attempts)} tools=${JSON.stringify(stage.tools)}`);
    for (const controller of attempt.controllers) {
      lines.push(`  controllerAttempt=${controller.attemptId} parentAttempt=${controller.parentAttemptId} outcome=${controller.outcome}`);
      for (const stage of controller.stages) lines.push(`    ${stage.stage} count=${stage.count} durationsMs=${JSON.stringify(stage.durationsMs)} outcomes=${JSON.stringify(stage.outcomes)} statuses=${JSON.stringify(stage.statuses)} attempts=${JSON.stringify(stage.attempts)} tools=${JSON.stringify(stage.tools)}`);
    }
    if (attempt.failedStages.length) lines.push(`  failures=${JSON.stringify(attempt.failedStages)}`);
  }
  lines.push('\nunknown 表示未观测；各阶段可能重叠，不能相加为总耗时。first_event/first_agent_message 不是模型 TTFT；API 接受不代表手机实收。');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const { values } = parseArgs({ options: { input: { type: 'string' }, 'trace-id': { type: 'string' },
    limit: { type: 'string', default: String(DEFAULT_LIMIT) }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) { process.stdout.write(HELP); return; }
  if (!/^[1-9]\d*$/u.test(values.limit) || !Number.isSafeInteger(Number(values.limit))) throw new Error('--limit must be a positive safe integer');
  let input;
  if (values.input) input = await readFile(values.input, 'utf8');
  else {
    process.stdin.setEncoding('utf8');
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    input = chunks.join('');
  }
  const { events, diagnostics } = parseLog(input);
  const report = { schema: 1, diagnostics, ...analyze(events, values['trace-id'], Number(values.limit)) };
  process.stdout.write(values.json ? `${JSON.stringify(report, null, 2)}\n` : textReport(report));
}

main().catch(error => { process.stderr.write(`analyze-message-latency: ${error.message}\n`); process.exitCode = 1; });
