import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Codex } from "@openai/codex-sdk";

function fakeCli(t: TestContext, mode: string) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sdk-lifecycle-"));
  const executable = path.join(directory, "codex.cjs");
  fs.writeFileSync(executable, `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const directory = process.env.FAKE_DIRECTORY;
const mode = process.env.FAKE_MODE;
fs.writeFileSync(path.join(directory, "pid"), String(process.pid));
process.on("SIGTERM", () => {
  fs.writeFileSync(path.join(directory, "term"), "received");
  if (mode !== "ignore-term") setTimeout(() => {
    fs.writeFileSync(path.join(directory, "cleaned"), "done");
    process.exit(0);
  }, 100);
});
process.stdin.resume();
if (mode === "normal") {
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "fake-thread" }) + "\\n");
  process.stdin.on("end", () => process.exit(0));
} else {
  process.stdout.write(mode === "malformed" ? "bad json\\n" :
    JSON.stringify({ type: "thread.started", thread_id: "fake-thread" }) + "\\n");
  setInterval(() => {}, 1000);
}
`, { mode: 0o700 });
  const pid = () => Number(fs.readFileSync(path.join(directory, "pid"), "utf8"));
  const alive = () => {
    try { process.kill(pid(), 0); return true; }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
      throw error;
    }
  };
  t.after(() => {
    if (fs.existsSync(path.join(directory, "pid")) && alive()) process.kill(pid(), "SIGKILL");
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const client = new Codex({ codexPathOverride: executable,
    env: { FAKE_DIRECTORY: directory, FAKE_MODE: mode } });
  return { directory, alive, thread: client.startThread({ skipGitRepoCheck: true }) };
}

test("malformed native output waits for process cleanup before rejecting", { timeout: 5000 }, async t => {
  const child = fakeCli(t, "malformed");
  const { events } = await child.thread.runStreamed("input");
  await assert.rejects(async () => { for await (const _event of events) { /* consume native output */ } }, /Failed to parse item/);
  assert.equal(fs.readFileSync(path.join(child.directory, "cleaned"), "utf8"), "done");
  assert.equal(child.alive(), false);
});

test("early iterator return waits for the native child to exit", { timeout: 5000 }, async t => {
  const child = fakeCli(t, "early-return");
  const { events } = await child.thread.runStreamed("input");
  const iterator = events[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.type, "thread.started");
  await iterator.return?.(undefined);
  assert.equal(fs.existsSync(path.join(child.directory, "cleaned")), true);
  assert.equal(child.alive(), false);
});

test("abort escalates SIGTERM to SIGKILL and waits for an uncooperative child", { timeout: 5000 }, async t => {
  const child = fakeCli(t, "ignore-term");
  const abort = new AbortController();
  const { events } = await child.thread.runStreamed("input", { signal: abort.signal });
  const iterator = events[Symbol.asyncIterator]();
  await iterator.next();
  const pending = iterator.next();
  abort.abort();
  await assert.rejects(pending, /abort/i);
  assert.equal(fs.existsSync(path.join(child.directory, "term")), true);
  assert.equal(child.alive(), false);
});

test("normal process exit completes without termination", { timeout: 5000 }, async t => {
  const child = fakeCli(t, "normal");
  const { events } = await child.thread.runStreamed("input");
  const seen = [];
  for await (const event of events) seen.push(event.type);
  assert.deepEqual(seen, ["thread.started"]);
  assert.equal(fs.existsSync(path.join(child.directory, "term")), false);
  assert.equal(child.alive(), false);
});

test("spawn failure and pre-aborted turns settle without waiting for a missing exit event", { timeout: 5000 }, async t => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sdk-missing-cli-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const missing = new Codex({ codexPathOverride: path.join(directory, "missing") }).startThread();
  const { events } = await missing.runStreamed("input");
  await assert.rejects(async () => { for await (const _event of events) { /* consume native output */ } }, /ENOENT/);
  const child = fakeCli(t, "ignore-term");
  const aborted = await child.thread.runStreamed("input", { signal: AbortSignal.abort() });
  await assert.rejects(async () => { for await (const _event of aborted.events) { /* consume native output */ } }, /abort/i);
});
