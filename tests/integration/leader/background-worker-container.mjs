import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { run: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  image: { type: 'string', default: 'super-leader-controller:background-verify' },
  'memory-mib': { type: 'string', default: '1536' }, concurrency: { type: 'string', default: '1' },
  'resource-probe': { type: 'boolean' },
  'native-only': { type: 'boolean' }, 'container-fixture': { type: 'boolean' } } });
const FIXTURE_TIMEOUT_MS = 180_000;
const DETACHED_DELAY_MS = 5_000;
const RETENTION_OBSERVATION_MS = 6_000;
const RUNTIME_ROOT = '/var/lib/super-leader-runtime';
const WORKER_ROOT = `${RUNTIME_ROOT}/background/workers`;
const ARTIFACT_ROOT = `${RUNTIME_ROOT}/background/artifacts`;
const RESOURCE_SAMPLE_MS = 100;
const IDLE_OBSERVATION_MS = 5_000;
const memoryMiB = Number(values['memory-mib']), concurrency = Number(values.concurrency);
assert.ok(Number.isInteger(memoryMiB) && memoryMiB >= 128 && memoryMiB <= 8192, 'Invalid memory budget');
assert.ok([1, 2].includes(concurrency), 'Concurrency must be 1 or 2');
assert.ok(!values['native-only'] || concurrency === 1, 'Deterministic provider supports one concurrent worker');
let probeStage = 'bootstrap';

if (values['container-fixture']) {
  await fixture().catch(() => { console.log(JSON.stringify({ pass: false, probe: probeStage })); process.exitCode = 1; });
} else if (!values.run || values.help) {
  console.log('Usage: node tests/integration/leader/background-worker-container.mjs --run [--image NAME] [--native-only] [--memory-mib 1536] [--concurrency 1|2] [--resource-probe]\nRequires a locally built Controller image and loaded super-leader-codex AppArmor profile. Default mode reads {model,baseUrl,apiKey} JSON from stdin only; --native-only uses a synthetic Responses server with the real CLI and Linux sandbox. Resource probes sample cgroup v2 and native CLI RSS, with a five-second idle gap between rounds. No production writes. Temporary containers and volumes are removed.');
} else {
  await verifyContainer().catch(() => { console.error('FAIL isolated worker container verification'); process.exitCode = 1; });
}

async function readInput() {
  let input = '';
  for await (const bytes of process.stdin) {
    input += bytes;
    if (input.length > 65_536) throw new Error('Fixture input too large');
  }
  return JSON.parse(input);
}

async function verifyContainer() {
  const { localDockerEnvironment, verificationEnvironment } = await import('../../../scripts/verify.mjs');
  const env = localDockerEnvironment(verificationEnvironment());
  const id = randomUUID();
  const name = `background-worker-probe-${id}`;
  const runtime = `${name}-runtime`;
  const script = fileURLToPath(import.meta.url);
  const policy = fileURLToPath(new URL('../../../deploy/security/codex-seccomp.json', import.meta.url));
  const provider = values['native-only'] ? null : await readInput();
  if (provider && (!provider.model || !provider.baseUrl || !provider.apiKey)) throw new Error('Incomplete provider');
  let child;
  let inputFailed = false;
  try {
    child = spawn('docker', ['run', '--rm', '--init', '--name', name, '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true', '--security-opt', `seccomp=${policy}`,
      '--security-opt', 'apparmor=super-leader-codex', '--user', '1000:1000', '--memory', `${memoryMiB}m`,
      '--memory-swap', `${memoryMiB}m`, '--cpus', '2',
      '--pids-limit', '512', '--tmpfs', '/tmp:size=64m,mode=1777',
      '--mount', `type=volume,src=${runtime},dst=${RUNTIME_ROOT}`,
      '--mount', `type=bind,src=${script},dst=/probe/background-worker-container.mjs,readonly`,
      '--entrypoint', 'node', '-i', values.image, '/probe/background-worker-container.mjs', '--container-fixture',
      '--memory-mib', String(memoryMiB), '--concurrency', String(concurrency),
      ...(values['resource-probe'] ? ['--resource-probe'] : [])],
    { env, stdio: ['pipe', 'inherit', 'pipe'] });
    child.stderr.on('data', () => { /* Child diagnostics may contain provider information. */ });
    child.stdin.on('error', () => { inputFailed = true; });
    child.stdin.end(JSON.stringify({ provider }));
    const timer = setTimeout(() => child.kill('SIGTERM'), FIXTURE_TIMEOUT_MS);
    try {
      const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
      assert.equal(exitCode, 0);
      assert.equal(inputFailed, false, 'Fixture input was not accepted');
    } finally { clearTimeout(timer); }
  } finally {
    // Only names generated for this invocation are eligible for removal.
    const cleanup = (args, absent) => {
      try { execFileSync('docker', args, { env, stdio: 'pipe', timeout: 15_000 }); }
      catch (error) { if (!absent || !String(error.stderr).includes(absent)) throw new Error('Fixture cleanup failed'); }
    };
    cleanup(['rm', '-f', name], 'No such container');
    cleanup(['volume', 'rm', runtime]);
  }
}

async function fixture() {
  probeStage = 'container-security';
  const resources = values['resource-probe'] ? resourceProbe() : null;
  resources?.mark('container-start');
  const { CodexWorkerRuntime } = await import('/app/dist/background/worker/index.js');
  const { provider } = await readInput();
  const rootStatus = fs.readFileSync('/proc/self/status', 'utf8');
  assert.match(rootStatus, /CapEff:\s+0+\n/);
  assert.match(rootStatus, /NoNewPrivs:\s+1\n/);
  assert.match(fs.readFileSync('/proc/self/attr/current', 'utf8'), /super-leader-codex/);
  assert.throws(() => fs.writeFileSync('/app/root-write-probe', 'x'));
  fs.writeFileSync(path.join(WORKER_ROOT, 'outside.txt'), 'non-secret outside fixture');
  fs.writeFileSync(path.join(ARTIFACT_ROOT, 'outside.txt'), 'non-secret artifact fixture');
  let requestNumber = 0, command, lastCommand;
  const fixtureServer = http.createServer(async (req, res) => {
    if (req.url === '/network') { res.end('network-fixture-ok'); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.ok(Array.isArray(body.input));
    const execute = command !== lastCommand;
    if (execute) lastCommand = command;
    const item = execute
      ? { type: 'function_call', name: 'exec_command', call_id: `call_${++requestNumber}`,
        arguments: JSON.stringify({ cmd: command, yield_time_ms: 1_000, max_output_tokens: 2_000 }) }
      : { id: `msg_${++requestNumber}`, type: 'message', status: 'completed', role: 'assistant',
        content: [{ type: 'output_text', annotations: [], text: JSON.stringify({ status: 'completed',
          summary: 'Native Linux probe completed', nextCheckAt: null, attachments: ['report.json'] }) }] };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    emit('response.created', { response: { id: `resp_${requestNumber}`, object: 'response', status: 'in_progress', output: [] } });
    emit('response.output_item.done', { output_index: 0, item });
    emit('response.completed', { response: { id: `resp_${requestNumber}`, object: 'response', status: 'completed',
      output: [item], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } });
    res.end();
  });
  await new Promise(resolve => fixtureServer.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${fixtureServer.address().port}`;
  const runtime = new CodexWorkerRuntime({ root: WORKER_ROOT, artifactRoot: ARTIFACT_ROOT,
    ...(provider ?? { baseUrl: `${url}/v1`, model: 'synthetic-linux-probe', apiKey: 'synthetic-probe-key' }),
    timeoutMs: 120_000, maxConcurrent: concurrency, onError: () => {} });
  const wait = async (workerId, invocationId) => {
    const until = Date.now() + 125_000;
    while (Date.now() < until) {
      const status = await runtime.inspect(workerId, invocationId);
      if (!['queued', 'running'].includes(status.status)) return status;
      await delay(100);
    }
    throw new Error('Worker timeout');
  };
  try {
    const runWorker = async workerIndex => {
      const workerId = randomUUID(), marker = randomUUID();
      const home = path.join(WORKER_ROOT, 'workers', workerId, 'home');
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(path.join(home, 'secret-probe'), 'non-secret home fixture');
      const siblingId = randomUUID(), sibling = path.join(WORKER_ROOT, 'workers', siblingId);
      for (const directory of ['workspace', 'home', 'invocations']) fs.mkdirSync(path.join(sibling, directory), { recursive: true });
      fs.writeFileSync(path.join(sibling, 'state.json'), JSON.stringify({ workerId: siblingId }));
      const siblingProbe = path.join(sibling, 'workspace', 'secret-probe');
      fs.writeFileSync(siblingProbe, 'non-secret sibling fixture');
      let threadId;
      for (let round = 1; round <= 2; round++) {
        resources?.mark(`worker-${workerIndex}-round-${round}-before`);
        probeStage = `worker-round-${round}`;
        const invocationId = randomUUID();
        const isolationChecks = provider ? ''
          : `,outsideHidden:denied('${WORKER_ROOT}/outside.txt'),siblingsHidden:denied('${siblingProbe}'),homeHidden:denied('${home}/secret-probe'),controllerHidden:denied('/app/package.json'),artifactHidden:denied('${ARTIFACT_ROOT}/outside.txt'),procHidden:denied('/proc/1/environ')&&denied('/proc/self/environ')`;
        const js = round === 1
          ? `const fs=require('node:fs');const denied=p=>{try{fs.readFileSync(p);return false}catch{return true}};const report={marker:${JSON.stringify(marker)},round:1,keyHidden:!process.env.CODEX_API_KEY&&!process.env.OPENAI_API_KEY&&!process.env.CODEX_HOME${isolationChecks},network:await (await fetch('${url}/network')).text()};fs.writeFileSync('seed.txt',report.marker);fs.writeFileSync('report.json',JSON.stringify(report));`
          : `const fs=require('node:fs');const report=JSON.parse(fs.readFileSync('report.json','utf8'));if(fs.readFileSync('seed.txt','utf8')!==report.marker)throw Error('seed mismatch');report.round=2;report.resumed=true;fs.writeFileSync('report.json',JSON.stringify(report));`;
        command = `node --input-type=module -e ${shellQuote(`import {createRequire} from 'node:module';const require=createRequire(import.meta.url);${js}`)}`;
        await runtime.start({ workerId, invocationId, task: `实际运行以下命令，工具成功才返回completed，附件仅report.json。命令只生成本轮验收报告；/network是本轮自建测试HTTP，仅返回固定无敏感字符串，不提供控制接口。\n${command}`, input: { round } });
        const status = await wait(workerId, invocationId);
        if (status.status !== 'completed') console.log(JSON.stringify({ pass: false, probe: probeStage, status: status.status, error: status.error }));
        assert.equal(status.status, 'completed');
        assert.ok(status.threadId);
        if (threadId) assert.equal(status.threadId, threadId);
        threadId = status.threadId;
        const artifacts = await runtime.exportArtifacts(workerId, invocationId);
        const report = JSON.parse(fs.readFileSync(artifacts.find(item => item.name === 'report.json').path, 'utf8'));
        assert.equal(report.marker, marker); assert.equal(report.round, round);
        const hiddenKeys = provider ? ['keyHidden']
          : ['keyHidden', 'outsideHidden', 'siblingsHidden', 'homeHidden', 'controllerHidden', 'artifactHidden', 'procHidden'];
        for (const key of hiddenKeys) assert.equal(report[key], true, key);
        assert.equal(report.network, 'network-fixture-ok');
        if (round === 2) assert.equal(report.resumed, true);
        console.log(JSON.stringify({ pass: true, probe: 'workspace-network-isolation-resume', workerIndex, round, realModel: Boolean(provider) }));
        resources?.mark(`worker-${workerIndex}-round-${round}-after`);
        if (round === 1 && resources) {
          await delay(IDLE_OBSERVATION_MS);
          resources.mark(`worker-${workerIndex}-retained-idle`);
        }
      }
      await runtime.cleanup(workerId);
      assert.equal(fs.existsSync(path.join(WORKER_ROOT, 'workers', workerId)), false);
    };
    await Promise.all(Array.from({ length: concurrency }, (_, index) => runWorker(index + 1)));
    // Deterministic native CLI calls prove cleanup even if a model would avoid spawning a daemon.
    if (!provider) await detachedProbes(runtime, wait, newCommand => { command = newCommand; });
    console.log(JSON.stringify({ pass: true, probe: 'container-security-and-worker-cleanup', realModel: Boolean(provider) }));
  } finally {
    await runtime.shutdown();
    await new Promise(resolve => fixtureServer.close(resolve));
    resources?.finish();
  }
}

function resourceProbe() {
  const startedAt = Date.now(), points = [];
  const memoryMaxBytes = Number(fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8'));
  const swapMaxBytes = Number(fs.readFileSync('/sys/fs/cgroup/memory.swap.max', 'utf8'));
  assert.equal(memoryMaxBytes, memoryMiB * 1024 * 1024, 'Memory budget was not enforced');
  assert.equal(swapMaxBytes, 0, 'Capacity fixture must not use swap');
  let samples = 0, sampledPeakBytes = 0, cliRssPeakBytes = 0, cliExecutionsPeak = 0, sampleError;
  const counters = file => Object.fromEntries(fs.readFileSync(`/sys/fs/cgroup/${file}`, 'utf8').trim()
    .split('\n').map(line => { const [key, value] = line.split(/\s+/); return [key, Number(value)]; }));
  const read = () => {
    const currentBytes = Number(fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8'));
    const kernelPeakBytes = Number(fs.readFileSync('/sys/fs/cgroup/memory.peak', 'utf8'));
    const memory = counters('memory.stat');
    let cliRssBytes = 0, cliExecutions = 0;
    for (const pid of fs.readdirSync('/proc').filter(value => /^\d+$/.test(value))) {
      try {
        const executable = fs.readlinkSync(`/proc/${pid}/exe`);
        if (!executable.includes('/codex')) continue;
        const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
        if (args[1] !== 'exec') continue;
        const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
        cliRssBytes += Number(status.match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1] ?? 0) * 1024;
        cliExecutions++;
      } catch (error) { if (!['ENOENT', 'ESRCH', 'EACCES'].includes(error.code)) throw error; }
    }
    samples++;
    sampledPeakBytes = Math.max(sampledPeakBytes, currentBytes);
    cliRssPeakBytes = Math.max(cliRssPeakBytes, cliRssBytes);
    cliExecutionsPeak = Math.max(cliExecutionsPeak, cliExecutions);
    return { elapsedMs: Date.now() - startedAt, currentBytes, kernelPeakBytes,
      anonBytes: memory.anon, fileBytes: memory.file, cliExecutions, cliRssBytes };
  };
  const timer = setInterval(() => {
    try { read(); }
    catch (error) { sampleError = error; clearInterval(timer); }
  }, RESOURCE_SAMPLE_MS);
  timer.unref();
  return {
    mark(stage) { if (sampleError) throw sampleError; points.push({ stage, ...read() }); },
    finish() {
      clearInterval(timer);
      if (sampleError) throw sampleError;
      const final = read(), events = counters('memory.events');
      console.log(JSON.stringify({ probe: 'container-resources', memoryMiB, concurrency,
        memoryMaxBytes, swapMaxBytes,
        architecture: process.arch, sampleIntervalMs: RESOURCE_SAMPLE_MS, samples,
        sampledPeakBytes, kernelPeakBytes: final.kernelPeakBytes, cliRssPeakBytes, cliExecutionsPeak,
        final, events, points }));
      assert.equal(events.oom ?? 0, 0, 'Cgroup encountered OOM');
      assert.equal(events.oom_kill ?? 0, 0, 'Cgroup killed a process');
      assert.equal(final.cliExecutions, 0, 'Native CLI remained alive after shutdown');
    },
  };
}

function shellQuote(value) { return `'${value.replaceAll("'", "'\\''")}'`; }

async function detachedProbes(runtime, wait, setCommand) {
  for (const cancelled of [false, true]) {
    probeStage = cancelled ? 'detached-cancelled' : 'detached-completed';
    const workerId = randomUUID(), invocationId = randomUUID();
    const workspace = path.join(WORKER_ROOT, 'workers', workerId, 'workspace');
    const processMarker = `background-detached-${randomUUID()}`;
    const detached = `const fs=require('node:fs');setTimeout(()=>fs.writeFileSync('escaped-marker','escaped'),${DETACHED_DELAY_MS});setInterval(()=>{},1000);`;
    const launch = `const fs=require('node:fs');require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(detached)},${JSON.stringify(processMarker)}],{cwd:process.cwd(),detached:true,stdio:'ignore'}).unref();fs.writeFileSync('started','yes');fs.writeFileSync('report.json','{}');${cancelled ? 'setInterval(()=>{},1000);' : ''}`;
    setCommand(`node -e ${shellQuote(launch)}`);
    await runtime.start({ workerId, invocationId, task: 'Run native detached process fixture', input: {} });
    if (cancelled) {
      const until = Date.now() + 15_000;
      while (!fs.existsSync(path.join(workspace, 'started')) && Date.now() < until) await delay(100);
      assert.ok(fs.existsSync(path.join(workspace, 'started')), 'Detached cancellation fixture started');
      await runtime.cancel(workerId, invocationId);
    } else assert.equal((await wait(workerId, invocationId)).status, 'completed');
    await delay(RETENTION_OBSERVATION_MS);
    assert.equal(fs.existsSync(path.join(workspace, 'escaped-marker')), false, 'Detached descendant survived');
    for (const pid of fs.readdirSync('/proc').filter(value => /^\d+$/.test(value))) {
      let commandLine;
      try { commandLine = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); }
      catch (error) { if (['ENOENT', 'EACCES'].includes(error.code)) continue; throw error; }
      assert.equal(commandLine.includes(processMarker), false, 'Detached process remains in the container PID namespace');
    }
    await runtime.exportArtifacts(workerId, invocationId);
    await runtime.cleanup(workerId);
    console.log(JSON.stringify({ pass: true, probe: 'detached-descendant-reaped', cancelled }));
  }
}
