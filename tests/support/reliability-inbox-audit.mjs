import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
export const INBOX_DISK_AUDIT_FAILURE_MARKER = 'INBOX_DISK_AUDIT_FAILED';

// Serialized into a private --import module; it never runs in the test driver.
function installInboxAudit({ statePath, auditPath, failurePath, failureMarker, maxSnapshotBytes }) {
  const fs = createRequire(import.meta.url)('node:fs');
  const originalRename = fs.renameSync;
  const inboxPath = statePath + '.inbox.json';
  const runId = randomUUID();
  let sequence = 0;
  let previousCursor = null;
  let auditFailed = false;

  try { fs.lstatSync(failurePath); auditFailed = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }

  try {
    const existing = fs.readFileSync(auditPath, 'utf8');
    for (const line of existing.trim().split('\n').filter(Boolean)) {
      const value = JSON.parse(line);
      if (value.sequence !== sequence + 1) throw new Error('Noncontiguous inbox audit sequence');
      sequence = value.sequence;
      auditFailed ||= value.auditFailed === true || value.event === 'inbox-disk-audit-error';
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  function snapshot(path) {
    let fd;
    try { fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
    catch (error) {
      if (error.code === 'ENOENT') return { exists: false };
      throw error;
    }
    let bytes;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > maxSnapshotBytes) throw new Error('Invalid inbox audit snapshot size or type');
      bytes = fs.readFileSync(fd);
      if (bytes.length > maxSnapshotBytes) throw new Error('Inbox audit snapshot exceeds byte budget');
    } finally { fs.closeSync(fd); }
    return { exists: true, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
      value: JSON.parse(bytes.toString('utf8')) };
  }

  function record(value) {
    const item = { event: 'inbox-disk-snapshot', sequence: sequence + 1, at: new Date().toISOString(),
      pid: process.pid, runId, ...value, auditFailed };
    fs.appendFileSync(auditPath, JSON.stringify(item) + '\n', { mode: 0o600 });
    sequence = item.sequence;
  }

  function reportFailure(value) {
    const text = failureMarker + ' ' + JSON.stringify(value) + '\n';
    try { fs.writeSync(2, text); }
    catch (error) {
      process.emitWarning(text + 'stderr write failed: ' + (error.code ?? error.name), { code: failureMarker });
    }
  }

  function fail(error, operation, target) {
    auditFailed = true;
    const failure = { at: new Date().toISOString(), pid: process.pid, runId, operation, target,
      errorCode: error.code ?? error.name };
    try { fs.writeFileSync(failurePath, JSON.stringify(failure) + '\n', { flag: 'wx', mode: 0o600 }); }
    catch (sentinelError) {
      if (sentinelError.code !== 'EEXIST') failure.sentinelErrorCode = sentinelError.code ?? sentinelError.name;
    }
    try { record({ event: 'inbox-disk-audit-error', ...failure }); }
    catch (recordError) { failure.recordErrorCode = recordError.code ?? recordError.name; }
    reportFailure(failure);
  }

  function observe(operation, target) {
    try {
      const state = snapshot(statePath), inbox = snapshot(inboxPath);
      const cursor = typeof state.value?.sync_buf === 'string' ? state.value.sync_buf : null;
      record({ operation, target, cursor, previousCursor,
        cursorChanged: operation === 'rename' && target === 'state' && cursor !== previousCursor, state, inbox });
      previousCursor = cursor;
    } catch (error) {
      // The audit must not turn a successful product rename into a failed write.
      fail(error, operation, target);
    }
  }

  fs.renameSync = function(...args) {
    const result = originalRename.apply(this, args);
    const destination = args[1] instanceof URL ? fileURLToPath(args[1])
      : Buffer.isBuffer(args[1]) ? args[1].toString() : args[1];
    const path = resolve(destination);
    if (path === statePath || path === inboxPath) observe('rename', path === statePath ? 'state' : 'inbox');
    return result;
  };
  syncBuiltinESMExports();
  if (auditFailed) reportFailure({ pid: process.pid, runId, operation: 'startup', persistedFailure: true });
  observe('startup', null);
}

function parseRecords(text) {
  const records = text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  for (const [index, item] of records.entries()) {
    assert.equal(item.sequence, index + 1, 'Inbox disk audit sequence must remain contiguous across restarts');
    assert.equal(item.event, 'inbox-disk-snapshot', 'Inbox disk audit reported an observation failure');
    assert.equal(item.auditFailed, false, 'Inbox disk audit has a previous observation failure');
  }
  return records;
}

/** Observe only a fixture's private state and inbox, including existing files on restart. */
export async function writeInboxAuditPreload({ dir, statePath }) {
  const root = resolve(dir), state = resolve(statePath);
  const suffix = relative(root, state);
  assert(suffix && suffix !== '..' && !suffix.startsWith('..' + sep) && !isAbsolute(suffix),
    'Inbox audit state must be inside its private fixture directory');
  const preloadPath = join(root, 'inbox-disk-audit.mjs');
  const auditPath = join(root, 'inbox-disk-audit.jsonl');
  const failurePath = join(root, 'inbox-disk-audit.failed.json');
  assert(![preloadPath, auditPath, failurePath].includes(state), 'Inbox audit paths must not overwrite product state');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const source = `import { createRequire, syncBuiltinESMExports } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
${installInboxAudit.toString()}
installInboxAudit(${JSON.stringify({ statePath: state, auditPath, failurePath,
    failureMarker: INBOX_DISK_AUDIT_FAILURE_MARKER, maxSnapshotBytes: MAX_SNAPSHOT_BYTES })});
`;
  await writeFile(preloadPath, source, { mode: 0o600 });
  async function assertNoFailureSentinel() {
    try { await readFile(failurePath); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    assert.fail('Inbox disk audit has a persistent failure sentinel');
  }
  return { preloadPath, auditPath, failurePath, failureMarker: INBOX_DISK_AUDIT_FAILURE_MARKER,
    async readRecords({ stderr = '' } = {}) {
      assert.equal(typeof stderr, 'string');
      assert(!stderr.includes(INBOX_DISK_AUDIT_FAILURE_MARKER), 'Inbox disk audit stderr reports an observation failure');
      await assertNoFailureSentinel();
      let records;
      try { records = parseRecords(await readFile(auditPath, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; records = []; }
      await assertNoFailureSentinel();
      return records;
  } };
}
