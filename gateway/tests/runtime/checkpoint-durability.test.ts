import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { StateManager, writePrivateJsonSync } from "../../src/runtime/state.js";
import { ILinkClient } from "../../src/wechat/client.js";

function fixture(t: TestContext) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gateway-checkpoint-sync-")));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, statePath: path.join(directory, "state.json") };
}

function synchronizeFilesystemMocks(t: TestContext): void {
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

function directoryAncestors(directory: string): string[] {
  const ancestors: string[] = [];
  for (let current = fs.realpathSync(directory); ; current = path.dirname(current)) {
    ancestors.push(current);
    if (path.dirname(current) === current) return ancestors;
  }
}

function checkpointInNewProcess(statePath: string, failureDirectory: string): { error: string | null; synchronized: string[] } {
  const writerUrl = new URL("../../src/runtime/state.js", import.meta.url).href;
  const result = execFileSync(process.execPath, ["--input-type=module", "--eval", `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const { statePath, failureDirectory, writerUrl } = JSON.parse(fs.readFileSync(0, "utf8"));
    const directories = new Map();
    const synchronized = [];
    const { openSync, fsyncSync } = fs;
    fs.openSync = (...args) => {
      const fd = openSync(...args);
      if (fs.fstatSync(fd).isDirectory()) directories.set(fd, fs.realpathSync(String(args[0])));
      else directories.delete(fd);
      return fd;
    };
    fs.fsyncSync = fd => {
      const directory = directories.get(fd);
      if (directory) {
        synchronized.push(directory);
        if (directory === failureDirectory) throw Object.assign(new Error("injected directory sync failure"), { code: "EIO" });
      }
      fsyncSync(fd);
    };
    syncBuiltinESMExports();
    const { writePrivateJsonSync } = await import(writerUrl);
    let error = null;
    try { writePrivateJsonSync(statePath, { checkpoint: "new-process" }); }
    catch (failure) { error = failure.code ?? failure.name; }
    process.stdout.write(JSON.stringify({ error, synchronized }));
  `], { input: JSON.stringify({ statePath, failureDirectory, writerUrl }), encoding: "utf8", timeout: 10000 });
  return JSON.parse(result) as { error: string | null; synchronized: string[] };
}

test("checkpoint synchronizes file data before rename and the containing directory before returning", t => {
  const { directory, statePath } = fixture(t);
  const events: string[] = [];
  const { openSync, writeFileSync, fsyncSync, closeSync, renameSync } = fs;
  const kind = (fd: number) => fs.fstatSync(fd).isDirectory() ? "directory" : "file";
  t.mock.method(fs, "openSync", (...args: Parameters<typeof openSync>) => {
    const fd = openSync(...args);
    events.push(`open-${kind(fd)}`);
    return fd;
  });
  t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof writeFileSync>) => {
    events.push("write-file");
    return writeFileSync(...args);
  });
  t.mock.method(fs, "fsyncSync", (fd: number) => {
    events.push(`fsync-${kind(fd)}`);
    fsyncSync(fd);
  });
  t.mock.method(fs, "closeSync", (fd: number) => {
    events.push(`close-${kind(fd)}`);
    closeSync(fd);
  });
  t.mock.method(fs, "renameSync", (source: fs.PathLike, destination: fs.PathLike) => {
    renameSync(source, destination);
    events.push("rename");
  });
  synchronizeFilesystemMocks(t);

  writePrivateJsonSync(statePath, { checkpoint: "new" });

  assert.deepEqual(events, ["open-file", "write-file", "fsync-file", "close-file", "rename",
    ...directoryAncestors(directory).flatMap(() => ["open-directory", "fsync-directory", "close-directory"])]);
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath, "utf8")), { checkpoint: "new" });
  assert.deepEqual(fs.readdirSync(directory), ["state.json"]);
});

test("first checkpoint also synchronizes the entries of newly created parent directories", t => {
  const { directory } = fixture(t);
  const targetDirectory = path.join(directory, "new", "nested");
  const directories = new Map<number, string>();
  const synchronized: string[] = [];
  const { openSync, fsyncSync } = fs;
  t.mock.method(fs, "openSync", (...args: Parameters<typeof openSync>) => {
    const fd = openSync(...args);
    if (fs.fstatSync(fd).isDirectory()) directories.set(fd, String(args[0]));
    else directories.delete(fd);
    return fd;
  });
  t.mock.method(fs, "fsyncSync", (fd: number) => {
    if (directories.has(fd)) synchronized.push(directories.get(fd)!);
    fsyncSync(fd);
  });
  synchronizeFilesystemMocks(t);

  writePrivateJsonSync(path.join(targetDirectory, "state.json"), { checkpoint: "first" });

  assert.deepEqual(synchronized, directoryAncestors(targetDirectory));
});

for (const failureLevel of ["leaf", "parent", "existing-parent"] as const) {
  test(`checkpoint retries synchronize ancestors after ${failureLevel} directory EIO`, t => {
    const { directory } = fixture(t);
    const existingDirectory = fs.realpathSync(directory);
    const targetDirectory = path.join(existingDirectory, "new", "nested");
    const statePath = path.join(targetDirectory, "state.json");
    const failureDirectory = failureLevel === "leaf" ? targetDirectory :
      failureLevel === "parent" ? path.dirname(targetDirectory) : existingDirectory;
    const failure = Object.assign(new Error("injected directory sync failure"), { code: "EIO" });
    const existingMode = fs.statSync(existingDirectory).mode & 0o777;
    const directories = new Map<number, string>();
    const synchronized: string[] = [];
    let shouldFail = true;
    const { openSync, fsyncSync } = fs;
    t.mock.method(fs, "openSync", (...args: Parameters<typeof openSync>) => {
      const fd = openSync(...args);
      if (fs.fstatSync(fd).isDirectory()) directories.set(fd, fs.realpathSync(String(args[0])));
      else directories.delete(fd);
      return fd;
    });
    t.mock.method(fs, "fsyncSync", (fd: number) => {
      const currentDirectory = directories.get(fd);
      if (currentDirectory) {
        synchronized.push(currentDirectory);
        if (shouldFail && currentDirectory === failureDirectory) throw failure;
      }
      fsyncSync(fd);
    });
    synchronizeFilesystemMocks(t);

    assert.throws(() => writePrivateJsonSync(statePath, { checkpoint: "first" }), error => error === failure);
    synchronized.length = 0;
    assert.throws(() => writePrivateJsonSync(statePath, { checkpoint: "retry" }), error => error === failure);
    assert.ok(synchronized.includes(failureDirectory), "retry must revisit the failed directory even when mkdir creates nothing");

    shouldFail = false;
    synchronized.length = 0;
    writePrivateJsonSync(statePath, { checkpoint: "recovered" });
    assert.deepEqual(synchronized, directoryAncestors(targetDirectory));
    assert.deepEqual(JSON.parse(fs.readFileSync(statePath, "utf8")), { checkpoint: "recovered" });
    assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(targetDirectory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.dirname(targetDirectory)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(existingDirectory).mode & 0o777, existingMode);
    assert.deepEqual(fs.readdirSync(targetDirectory), ["state.json"]);
  });
}

test("checkpoint process restart cannot forget ancestors created before a failed synchronization", t => {
  const { directory } = fixture(t);
  const linkedDirectory = path.join(directory, "alias");
  fs.symlinkSync(directory, linkedDirectory, "dir");
  const targetDirectory = path.join(fs.realpathSync(directory), "new", "nested");
  const statePath = path.join(linkedDirectory, "new", "nested", "state.json");
  const first = checkpointInNewProcess(statePath, targetDirectory);
  assert.equal(first.error, "EIO");

  const restarted = checkpointInNewProcess(statePath, path.dirname(targetDirectory));
  assert.equal(restarted.error, "EIO", "a fresh process must synchronize ancestors that mkdir no longer reports");
  assert.deepEqual(restarted.synchronized, [targetDirectory, path.dirname(targetDirectory)]);

  const recovered = checkpointInNewProcess(statePath, "");
  assert.equal(recovered.error, null);
  assert.deepEqual(recovered.synchronized, directoryAncestors(targetDirectory));
  assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(targetDirectory).mode & 0o777, 0o700);
});

const directoryFailures = [
  { stage: "open", code: "EISDIR" },
  { stage: "fsync", code: "EINVAL" },
  { stage: "fsync", code: "ENOTSUP" },
  { stage: "fsync", code: "EIO" },
  { stage: "close", code: "EIO" },
] as const;

for (const { stage, code } of directoryFailures) {
  test(`checkpoint fails closed on directory ${stage} ${code} and releases opened descriptors`, t => {
    const { directory, statePath } = fixture(t);
    const failure = Object.assign(new Error("injected directory synchronization failure"), { code });
    const descriptors = new Set<number>();
    let closedDirectories = 0;
    const { openSync, fsyncSync, closeSync } = fs;
    t.mock.method(fs, "openSync", (...args: Parameters<typeof openSync>) => {
      if (String(args[0]) === directory && stage === "open") throw failure;
      const fd = openSync(...args);
      if (fs.fstatSync(fd).isDirectory()) descriptors.add(fd);
      return fd;
    });
    t.mock.method(fs, "fsyncSync", (fd: number) => {
      if (descriptors.has(fd) && stage === "fsync") throw failure;
      fsyncSync(fd);
    });
    t.mock.method(fs, "closeSync", (fd: number) => {
      const isDirectory = descriptors.has(fd);
      closeSync(fd);
      if (isDirectory) {
        descriptors.delete(fd);
        closedDirectories++;
        if (stage === "close") throw failure;
      }
    });
    synchronizeFilesystemMocks(t);

    assert.throws(() => writePrivateJsonSync(statePath, { checkpoint: "new" }), error => error === failure);
    assert.equal(descriptors.size, 0);
    assert.equal(closedDirectories, stage === "open" ? 0 : 1);
    assert.deepEqual(fs.readdirSync(directory), ["state.json"]);
  });
}

test("directory synchronization failure in reply intent prevents the transport send", async t => {
  const { directory, statePath } = fixture(t);
  const credentials = path.join(directory, "account.json");
  fs.writeFileSync(credentials, JSON.stringify({ token: "synthetic", accountId: "fixture" }));
  const state = new StateManager(credentials, statePath);
  state.setContextToken("chat", "synthetic-context");
  state.recordInboundContext("inbound", "chat", Date.now() - 1000);
  const deliveryKey = "directory-failure";
  const failure = Object.assign(new Error("injected directory synchronization failure"), { code: "EIO" });
  const { fsyncSync } = fs;
  t.mock.method(fs, "fsyncSync", (fd: number) => {
    if (fs.fstatSync(fd).isDirectory() && state.hasUncertainReply(deliveryKey)) throw failure;
    fsyncSync(fd);
  });
  synchronizeFilesystemMocks(t);
  let sends = 0;
  const client = new ILinkClient({ stateManager: state, fetchImpl: async input => {
    const url = String(input);
    if (url.endsWith("sendmessage")) sends++;
    return Response.json(url.endsWith("getconfig") ? { ret: 0, typing_ticket: "synthetic-ticket" } : { ret: 0 });
  } });

  await assert.rejects(client.sendMarkdownReply("chat", "reply", { deliveryKey }), error => error === failure);

  assert.equal(sends, 0);
  assert.equal(state.hasUncertainReply(deliveryKey), false, "failed intent rolls back the live state");
  assert.equal(new StateManager(credentials, statePath).hasUncertainReply(deliveryKey), true,
    "rename may already be visible after a failed directory sync, so reload retains the intent");
});
