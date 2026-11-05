import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { ACTIVATION_STATUS, REMOTE_FILES } from '../../../scripts/deploy/transfer-files.mjs';
import { stopTestProcess, withTestCleanup } from '../../support/cleanup.mjs';

const WAIT_MS = 5_000;
const POLL_MS = 20;

async function waitForFile(path) {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    try { return await readFile(path, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert.ok(Date.now() < deadline, `activation fixture must publish ${path}`);
    await delay(POLL_MS);
  }
}

test('a lost readiness reader publishes failure without executing the release script', async t => {
  const root = await mkdtemp(join(tmpdir(), 'activation-readiness-'));
  const stage = join(root, 'stage'), startup = join(root, 'startup');
  const childFile = join(root, 'child.pid'), gate = join(root, 'detach-gate'), executed = join(root, 'executed');
  let launcher, childPid;
  t.after(() => withTestCleanup(async () => {}, [
    { label: 'launching helper', cleanup: () => stopTestProcess(launcher) },
    { label: 'owned activation child', cleanup() {
      if (!childPid) return;
      const state = spawnSync('ps', ['-o', 'stat=,command=', '-p', String(childPid)], {
        encoding: 'utf8', timeout: WAIT_MS,
      });
      if (state.error) throw state.error;
      assert.equal(state.stderr.trim(), '');
      if (state.status === 1 && !state.stdout.trim()) return;
      assert.equal(state.status, 0);
      if (/^Z/.test(state.stdout.trim())) return;
      assert.ok(state.stdout.includes(` ${stage} fixture-owner activate `), 'cleanup targets only the owned helper');
      try { process.kill(childPid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    } },
    { label: 'activation fixture', cleanup: () => rm(root, { recursive: true, force: true }) },
  ]));
  await mkdir(stage);
  await mkdir(startup);
  await writeFile(join(stage, '.transfer-owner'), 'fixture-owner');
  await writeFile(join(stage, 'remote-release.sh'), `#!/bin/sh\ntouch '${executed}'\n`, { mode: 0o700 });
  await writeFile(join(startup, 'sitecustomize.py'), `import os,time
setsid=os.setsid
def gated_setsid():
 path=os.environ['TEST_ACTIVATION_CHILD_PID']
 with open(path+'.tmp','w') as f:f.write(str(os.getpid()))
 os.replace(path+'.tmp',path)
 deadline=time.monotonic()+${WAIT_MS / 1000}
 while not os.path.exists(os.environ['TEST_ACTIVATION_DETACH_GATE']):
  if time.monotonic()>=deadline:os._exit(92)
  time.sleep(${POLL_MS / 1000})
 return setsid()
os.setsid=gated_setsid
`);
  launcher = spawn('python3', ['-', stage, 'fixture-owner', 'activate',
    Buffer.from(JSON.stringify(['--release-dir', root])).toString('base64')], {
    detached: true, stdio: ['pipe', 'ignore', 'ignore'],
    env: { ...process.env, PYTHONPATH: startup, TEST_ACTIVATION_CHILD_PID: childFile,
      TEST_ACTIVATION_DETACH_GATE: gate },
  });
  const exited = once(launcher, 'exit');
  launcher.stdin.end(REMOTE_FILES);
  childPid = Number(await waitForFile(childFile));
  assert.ok(Number.isSafeInteger(childPid) && childPid > 0);
  assert.equal(launcher.kill('SIGKILL'), true);
  await exited;
  await writeFile(gate, 'detach');
  assert.equal(await waitForFile(join(stage, ACTIVATION_STATUS)), '77');
  await assert.rejects(access(executed), { code: 'ENOENT' });
});
