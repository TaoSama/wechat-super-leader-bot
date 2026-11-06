import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { parseAndValidateResponse } from '../../controller/dist/leader/model/response-parser.js';
import { classifyBackgroundAuthorization } from '../../controller/dist/leader/model/background-authorization.js';
import { LocalSettingsService } from '../../controller/dist/settings/local-service.js';
import { buildLeaderPrompt, buildStaticLayers, leaderInputItems } from '../../gateway/dist/leader/prompt.js';
import { withSourceFollowupFixture } from '../support/source-followup-fixture.mjs';
import { recordedModel, sha256 } from '../support/source-followup-model-client.mjs';

const { values } = parseArgs({ options: { run: { type: 'boolean' }, output: { type: 'string' },
  resume: { type: 'string' }, cases: { type: 'string', default: 'pair' }, help: { type: 'boolean', short: 'h' } } });
if (!values.run || values.help) {
  console.log('Usage: FOLLOWUP_API_KEY=… FOLLOWUP_BASE_URL=… FOLLOWUP_MODEL=… node tests/live/source-followup-model.mjs --run --output PATH [--cases pair|boundaries|authorization] [--resume PATH]\nOpt-in real Responses API inference; store=false. All tools route only to an isolated Controller and synthetic node. Does not create native chats or send WeChat. Omit FOLLOWUP_EFFORT to omit effort from requests. Resume preserves a saved tool selection after a fixture repair; it cannot restore discarded encrypted reasoning.');
} else {
  await run().catch(error => { console.error(error.message); process.exitCode = 1; });
}

/** The model chooses every call; fixed scenario order is not a prescribed tool sequence. */
async function run() {
  assert(values.output, '--output required');
  assert(['pair', 'boundaries', 'authorization'].includes(values.cases), 'Invalid --cases');
  const apiKey = process.env.FOLLOWUP_API_KEY;
  const modelName = process.env.FOLLOWUP_MODEL, baseUrl = process.env.FOLLOWUP_BASE_URL;
  assert(apiKey && modelName && baseUrl, 'Explicit model environment required');
  const baselineText = await readFile(new URL('../fixtures/source-followup-baseline.json', import.meta.url), 'utf8');
  const old = JSON.parse(baselineText);
  const productionPrompt = old.systemPrompt;
  const resume = values.resume ? JSON.parse(await readFile(values.resume, 'utf8')) : undefined;
  const options = { apiKey, model: modelName, baseUrl,
    ...(process.env.FOLLOWUP_EFFORT ? { reasoningEffort: process.env.FOLLOWUP_EFFORT } : {}) };
  const evidence = { observedAt: new Date().toISOString(), sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    harnessSha256: sha256(await readFile(new URL(import.meta.url))),
    baselineRevision: old.sourceRevision, baselineSha256: sha256(baselineText),
    surface: 'real Responses API → built Controller CLI HTTP tools → synthetic source WebSocket',
    scope: 'API configuration behavior comparison; flattened function transport, not native Codex equivalence',
    configuration: { model: modelName, baseUrl, reasoningEffort: process.env.FOLLOWUP_EFFORT || null,
      store: false, nativeChats: false, productionBusinessCalls: false },
    attemptsPerScenario: 1, modelInference: true, continuedFrom: values.resume ?? null, scenarios: [], complete: false };
  // Exclusive first write protects earlier failed attempts from accidental replacement.
  await writeFile(values.output, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
  const save = () => writeFile(values.output, JSON.stringify(evidence, null, 2) + '\n');
  try {
    if (values.cases === 'authorization') await verifyAuthorization(evidence, options, old, save);
    else await withSourceFollowupFixture(async fixture => {
      const scenarios = values.cases === 'pair' ? [['old', 'later-result'], ['new', 'later-result']]
        : ['empty', 'truncated', 'read-failed'].map(mode => ['new', mode]);
      for (const [version, mode] of scenarios) {
        fixture.setMode(mode);
        const item = { version, mode, api: [], calls: [], final: null, failure: null, assessment: 'pending' };
        evidence.scenarios.push(item);
        const user = { chatId: fixture.chatId, messageId: randomUUID(), text: '但是他最终成功了，你不信再读一下' };
        try {
          const catalog = await fixture.catalog(user);
          const tools = catalog.tools.map(tool => {
            const baseline = version === 'old' ? old.tools.find(prior => prior.name === tool.name) : undefined;
            return { type: 'function', function: { name: tool.name, description: baseline?.description ?? tool.description,
              parameters: tool.inputSchema } };
          });
          const instructions = version === 'old' ? old.instructions : catalog.instructions;
          item.catalog = { instructions, tools };
          const prior = { originalUser: '核对11月6日08:00日报那次定时任务的结果',
            nodes: await fixture.call(user, 'list_nodes', {}),
            sourceAutomations: await fixture.call(user, 'list_source_automations', { nodeId: fixture.nodeId }),
            inspectionArguments: fixture.source, inspection: await fixture.call(user, 'inspect_source_automation', fixture.source),
            previousAnswer: '原08:00定时轮次记录为失败。' };
          item.priorContext = prior;
          const preflight = await fixture.call(user, 'read_session', { nodeId: fixture.nodeId, sessionId: fixture.sessionId });
          item.fixturePreflight = preflight;
          if (mode === 'later-result') assert.equal(preflight.items?.[0]?.text, '11月6日日报已完成，采用08:31:12修复后快照。', 'Synthetic history must validate before model inference');
          if (mode === 'empty') assert.deepEqual(preflight.items, []);
          if (mode === 'truncated') assert.equal(preflight.items?.[0]?.truncated && preflight.truncated, true);
          if (mode === 'read-failed') assert.equal(preflight.code, 'history_failed');
          const emptyMemory = Object.fromEntries(['task.md', 'memory.md', 'preference.md'].map(name => [name, { content: '', truncated: false }]));
          const prompt = buildLeaderPrompt(emptyMemory, user, { systemPrompt: productionPrompt,
            includeStatic: false, controllerInstructions: instructions, controllerContext: `<prior_context>${JSON.stringify(prior)}</prior_context>` });
          let messages = [{ role: 'system', content: buildStaticLayers(instructions, productionPrompt) + '\n工具传输适配：wechat_control 工具在本次 API 中作为同名 function tools 提供，直接使用函数目录。业务规则不变。' },
            ...leaderInputItems(prompt).map(content => ({ role: 'user', content }))];
          let pendingReply;
          if (resume) {
            const priorScenario = resume.scenarios.find(scenario => scenario.version === version && scenario.mode === mode);
            const resumeIndex = priorScenario?.api.findLastIndex(record => record.response?.output.some(output => output.type === 'function_call'));
            assert(resumeIndex >= 0, 'A previously selected tool call is required');
            const first = priorScenario.api[resumeIndex];
            assert(!first.response.output.some(output => output.type === 'reasoning'), 'Cannot restore discarded encrypted reasoning');
            assert(!first.request.input.some(input => input.type === 'reasoning'), 'Cannot restore a request containing discarded encrypted reasoning');
            assert.equal(first.request.model, options.model, 'Resumed model must be identical');
            assert.equal(first.request.reasoning?.effort, options.reasoningEffort, 'Resumed effort must be identical');
            assert.equal(resume.configuration.baseUrl, baseUrl, 'Resumed provider must be identical');
            assert.deepEqual(priorScenario.catalog, item.catalog, 'Resumed tool catalog must be identical');
            messages = [{ role: 'assistant', content: null, responseOutput: first.request.input }];
            pendingReply = parseAndValidateResponse(JSON.stringify(first.response));
            item.api.push(...priorScenario.api.slice(0, resumeIndex + 1).map(record => ({ ...record, reusedCompletion: true })));
            item.resumedPendingCallAfterAdapterFix = true;
            item.resumedApiIndex = resumeIndex;
          }
          const model = recordedModel(options, item.api, save);
          const signal = AbortSignal.timeout(6 * 60_000);
          for (let step = 0; step < 8; step++) {
            const reply = pendingReply ?? await model.complete(messages, tools, signal);
            pendingReply = undefined;
            item.final = reply.content;
            if (!reply.toolCalls.length) break;
            messages.push({ role: 'assistant', content: reply.content, tool_calls: reply.toolCalls, responseOutput: reply.responseOutput });
            for (const call of reply.toolCalls) {
              assert(item.calls.length < 12, 'Model tool-call bound exceeded');
              const selected = { name: call.function.name, arguments: JSON.parse(call.function.arguments) };
              item.calls.push(selected); await save();
              try {
                assert.deepEqual(Object.keys(selected.arguments), ['arguments'], 'MCP function arguments require exactly one arguments envelope');
                selected.result = await fixture.call(user, selected.name, selected.arguments.arguments);
              }
              catch (error) { selected.blockedOrFailed = error.message; throw error; }
              messages.push({ role: 'tool', content: JSON.stringify(selected.result), tool_call_id: call.id });
            }
            if (step === 7) throw new Error('Model completion bound exceeded');
          }
          item.originalAfter = await fixture.call(user, 'inspect_source_automation', fixture.source);
          assert.deepEqual(item.originalAfter, prior.inspection);
          assert.deepEqual(await fixture.call(user, 'list_background_tasks', {}), []);
          assert.deepEqual(await fixture.call(user, 'list_automations', {}), []);
          item.modelSelectedReadSession = item.calls.some(call => call.name === 'read_session');
          item.fullSelectedToolSequence = item.api.flatMap(record => (record.response?.output ?? [])
            .filter(output => output.type === 'function_call').map(output => output.name));
          item.originalOccurrenceUnchanged = true;
          assert(item.modelSelectedReadSession, 'Model did not choose the required source history read');
          assert(item.final?.trim(), 'Model did not produce a public final answer');
          item.assessment = 'requires_public_answer_review';
        } catch (error) { item.failure = error.message; item.assessment = 'failed'; }
        await save();
        console.log(JSON.stringify({ version, mode, calls: item.calls.map(call => call.name), failure: item.failure,
          modelSelectedReadSession: item.modelSelectedReadSession, final: item.final }));
      }
      evidence.daemonFrameCounts = Object.fromEntries([...new Set(fixture.frames.map(frame => frame.type))]
        .map(type => [type, fixture.frames.filter(frame => frame.type === type).length]));
      assert.equal(fixture.errors.length, 0);
    });
    evidence.complete = true;
  } catch (error) { evidence.fixtureFailure = error.message; }
  finally { await save(); }
  if (!evidence.complete || evidence.scenarios.some(item => item.failure || item.version === 'new' && item.matchesExpected === false)) process.exitCode = 1;
}

/** Exercises the built classifier and settings wrapper; classifications never execute a selected operation. */
async function verifyAuthorization(evidence, options, baseline, save) {
  const root = await mkdtemp(path.join(tmpdir(), 'source-followup-authorization-'));
  try {
    for (const version of ['old', 'new']) {
      const settings = new LocalSettingsService({ root: path.join(root, version), leader: options });
      if (version === 'old') {
        const id = 'controller.prompt.background-authorization';
        settings.updateResource(id, baseline.authorizationPrompt, settings.readResource(id).revision);
      }
      for (const [text, expected] of [['但是他最终成功了，你不信再读一下', []], ['再看看刚才那个', []], ['让它继续核对第二项', ['follow_up']]]) {
        const item = { version, mode: 'authorization', text, expected, api: [], operations: null, failure: null };
        evidence.scenarios.push(item);
        try {
          const model = settings.wrapModel(recordedModel(options, item.api, save));
          item.operations = [...await classifyBackgroundAuthorization(model, text, AbortSignal.timeout(120_000))];
          item.matchesExpected = JSON.stringify(item.operations) === JSON.stringify(expected);
        } catch (error) { item.failure = error.message; }
        await save();
        console.log(JSON.stringify({ version, text, operations: item.operations, matchesExpected: item.matchesExpected, failure: item.failure }));
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}
