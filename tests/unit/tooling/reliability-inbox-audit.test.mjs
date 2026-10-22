import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verificationEnvironment } from '../../../scripts/verify.mjs';
import { INBOX_DISK_AUDIT_FAILURE_MARKER, writeInboxAuditPreload } from '../../support/reliability-inbox-audit.mjs';

const PROCESS_TIMEOUT_MS = 5_000;
const ACTOR_SETUP = `import assert from 'node:assert/strict';
import fs from 'node:fs';
function atomicJson(path, value) {
  const temporary = path + '.synthetic.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value) + '\\n', { mode: 0o600 });
  assert.equal(fs.renameSync(temporary, path), undefined);
}
`;

async function withAuditFixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'slr-inbox-audit-unit-'));
  try {
    const statePath = join(dir, 'state.json');
    await run({ dir, statePath, ...await writeInboxAuditPreload({ dir, statePath }) });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

function runActor(fixture, source = '', beforeImport) {
  const result = spawnSync(process.execPath, [
    ...(beforeImport ? ['--import', beforeImport] : []), '--import', fixture.preloadPath,
    '--input-type=module', '--eval', ACTOR_SETUP + source,
  ], { env: { ...verificationEnvironment(), NODE_NO_WARNINGS: '1' }, encoding: 'utf8',
    timeout: PROCESS_TIMEOUT_MS, killSignal: 'SIGKILL' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return result;
}

test('observes exact rename destinations after disk commit and continues ordering across processes', async () => {
  await withAuditFixture(async fixture => {
    const tuple = { chatId: 'synthetic-chat', text: '原始消息\n保留尾部空格  ', messageId: 'synthetic-stable-id',
      deliveryKey: 'synthetic-delivery-key', contextToken: 'synthetic-context', createdAtMs: 1792690000000 };
    const inbox = { version: 1, fingerprint: 'synthetic-fingerprint', items: [tuple] };
    runActor(fixture, `
      const statePath = ${JSON.stringify(fixture.statePath)};
      atomicJson(statePath + '.other', { unrelated: true });
      atomicJson(statePath + '.inbox.json.extra', { unrelated: true });
      assert.throws(() => fs.renameSync(statePath + '.missing', statePath), { code: 'ENOENT' });
      atomicJson(statePath, { sync_buf: 'synthetic-cursor-0' });
      atomicJson(statePath + '.inbox.json', ${JSON.stringify(inbox)});
      atomicJson(statePath, { sync_buf: 'synthetic-cursor-1' });
    `);
    runActor(fixture);
    const records = await fixture.readRecords();
    assert.deepEqual(records.map(value => [value.sequence, value.operation, value.target]), [
      [1, 'startup', null], [2, 'rename', 'state'], [3, 'rename', 'inbox'], [4, 'rename', 'state'], [5, 'startup', null],
    ]);
    assert(records.every(value => value.auditFailed === false));
    assert.equal(records[1].inbox.exists, false);
    assert.equal(records[2].state.value.sync_buf, 'synthetic-cursor-0');
    assert.deepEqual(records[2].inbox.value.items, [tuple]);
    assert.equal(records[3].cursorChanged, true);
    assert.equal(records[3].previousCursor, 'synthetic-cursor-0');
    assert.equal(records[3].cursor, 'synthetic-cursor-1');
    assert.deepEqual(records[3].inbox.value.items, [tuple]);
    const diskBytes = await readFile(fixture.statePath + '.inbox.json');
    assert.equal(records[3].inbox.bytes, diskBytes.length);
    assert.equal(records[3].inbox.sha256, createHash('sha256').update(diskBytes).digest('hex'));
    assert.equal(records[4].cursor, 'synthetic-cursor-1');
    assert.deepEqual(records[4].inbox, records[3].inbox);
    assert.notEqual(records[4].runId, records[3].runId);
  });
});

test('append and sentinel failures stay observable through stderr and later records across restart', async () => {
  await withAuditFixture(async fixture => {
    const hook = join(fixture.dir, 'synthetic-audit-write-failure.mjs');
    await writeFile(hook, `import fs from 'node:fs';
const append = fs.appendFileSync, write = fs.writeFileSync;
globalThis.blockAuditWrites = true;
fs.appendFileSync = function(path, ...args) {
  if (globalThis.blockAuditWrites && path === ${JSON.stringify(fixture.auditPath)}) {
    throw Object.assign(new Error('Synthetic audit append denied'), { code: 'EACCES' });
  }
  return append.call(this, path, ...args);
};
fs.writeFileSync = function(path, ...args) {
  if (globalThis.blockAuditWrites && path === ${JSON.stringify(fixture.failurePath)}) {
    throw Object.assign(new Error('Synthetic audit sentinel denied'), { code: 'EACCES' });
  }
  return write.call(this, path, ...args);
};
`);
    const initial = runActor(fixture, '', hook);
    assert(initial.stderr.includes(INBOX_DISK_AUDIT_FAILURE_MARKER));
    await assert.rejects(readFile(fixture.auditPath), { code: 'ENOENT' });
    await assert.rejects(readFile(fixture.failurePath), { code: 'ENOENT' });
    await assert.rejects(fixture.readRecords({ stderr: initial.stderr }), /stderr reports an observation failure/);

    const recovered = runActor(fixture, `
      globalThis.blockAuditWrites = false;
      atomicJson(${JSON.stringify(fixture.statePath)}, { sync_buf: 'synthetic-cursor-1' });
    `, hook);
    assert(recovered.stderr.includes(INBOX_DISK_AUDIT_FAILURE_MARKER));
    assert.equal(JSON.parse(await readFile(fixture.statePath, 'utf8')).sync_buf, 'synthetic-cursor-1');
    await assert.rejects(fixture.readRecords(), /previous observation failure/);
    const restarted = runActor(fixture);
    assert(restarted.stderr.includes(INBOX_DISK_AUDIT_FAILURE_MARKER));
    const records = (await readFile(fixture.auditPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(records.map(value => [value.sequence, value.operation, value.auditFailed]), [
      [1, 'rename', true], [2, 'startup', true],
    ]);
    await assert.rejects(readFile(fixture.failurePath), { code: 'ENOENT' });
    await assert.rejects(fixture.readRecords(), /previous observation failure/);
  });
});
