import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Codex, type CodexLifecycleEvent } from "@openai/codex-sdk";

const SDK_TEST_TIMEOUT_MS = 20_000;

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
if (mode === "normal" || mode === "inherited-stderr" || mode === "inherited-pipes-hang") {
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "fake-thread" }) + "\\n");
  if (mode === "inherited-stderr") {
    require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 250)"],
      { stdio: ["ignore", "ignore", process.stderr] }).unref();
  }
  if (mode === "inherited-pipes-hang") {
    const descendant = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"],
      { stdio: ["ignore", process.stdout, process.stderr] });
    fs.writeFileSync(path.join(directory, "descendant-pid"), String(descendant.pid));
    descendant.unref();
  }
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
    const descendantPid = path.join(directory, "descendant-pid");
    if (fs.existsSync(descendantPid)) {
      try { process.kill(Number(fs.readFileSync(descendantPid, "utf8")), "SIGKILL"); }
      catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
      }
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const client = new Codex({ codexPathOverride: executable,
    env: { FAKE_DIRECTORY: directory, FAKE_MODE: mode } });
  return { directory, alive, thread: client.startThread({ skipGitRepoCheck: true }) };
}

test("malformed native output waits for process cleanup before rejecting", { timeout: SDK_TEST_TIMEOUT_MS }, async t => {
  const child = fakeCli(t, "malformed");
  const { events } = await child.thread.runStreamed("input");
  await assert.rejects(async () => { for await (const _event of events) { /* consume native output */ } }, /Failed to parse item/);
  assert.equal(fs.readFileSync(path.join(child.directory, "cleaned"), "utf8"), "done");
  assert.equal(child.alive(), false);
});

test("early iterator return waits for the native child to exit", { timeout: SDK_TEST_TIMEOUT_MS }, async t => {
  const child = fakeCli(t, "early-return");
  const { events } = await child.thread.runStreamed("input");
  const iterator = events[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.type, "thread.started");
  await iterator.return?.(undefined);
  assert.equal(fs.existsSync(path.join(child.directory, "cleaned")), true);
  assert.equal(child.alive(), false);
});

test("abort escalates SIGTERM to SIGKILL and waits for an uncooperative child", { timeout: SDK_TEST_TIMEOUT_MS }, async t => {
  const child = fakeCli(t, "ignore-term");
  const abort = new AbortController();
  const lifecycle: CodexLifecycleEvent[] = [];
  const { events } = await child.thread.runStreamed("input", { signal: abort.signal,
    onLifecycleEvent: event => lifecycle.push(event) });
  const iterator = events[Symbol.asyncIterator]();
  await iterator.next();
  const pending = iterator.next();
  abort.abort();
  await assert.rejects(pending, /abort/i);
  assert.equal(fs.existsSync(path.join(child.directory, "term")), true);
  assert.equal(child.alive(), false);
  assert.equal(lifecycle.filter(event => event.type === "termination_requested").length, 1);
  assert.equal(lifecycle.filter(event => event.type === "termination_escalated").length, 1);
  assert.equal(lifecycle.at(-1)?.type, "cleanup_finished");
});

test("normal process exit completes without termination", { timeout: SDK_TEST_TIMEOUT_MS }, async t => {
  const child = fakeCli(t, "normal");
  const { events } = await child.thread.runStreamed("input");
  const seen = [];
  for await (const event of events) seen.push(event.type);
  assert.deepEqual(seen, ["thread.started"]);
  assert.equal(fs.existsSync(path.join(child.directory, "term")), false);
  assert.equal(child.alive(), false);
});

test("lifecycle metadata separates process exit from inherited stdio closure", { timeout: SDK_TEST_TIMEOUT_MS }, async t => {
  const child = fakeCli(t, "inherited-stderr");
  const lifecycle: CodexLifecycleEvent[] = [];
  const { events } = await child.thread.runStreamed("private-input", {
    onLifecycleEvent: event => lifecycle.push(event),
  });
  for await (const _event of events) { /* consume native output */ }
  const exit = lifecycle.find(event => event.type === "child_exit")!;
  const close = lifecycle.find(event => event.type === "child_close")!;
  assert.ok(exit && close);
  assert.ok(close.elapsedMs - exit.elapsedMs >= 100, "inherited stderr must delay close after exit");
  assert.ok(lifecycle.some(event => event.type === "stdout_end"));
  assert.ok(lifecycle.some(event => event.type === "stderr_end"));
  assert.equal(lifecycle.at(-1)?.type, "cleanup_finished");
  assert.equal(lifecycle.some(event => event.type.startsWith("termination_")), false);
  for (const [index, event] of lifecycle.entries()) {
    assert.ok(Number.isFinite(event.elapsedMs) && event.elapsedMs >= (lifecycle[index - 1]?.elapsedMs ?? 0));
    assert.deepEqual(Object.keys(event).sort(), event.type.startsWith("child_")
      ? ["elapsedMs", "exitCode", "signal", "type"] : ["elapsedMs", "type"]);
  }
  assert.equal(JSON.stringify(lifecycle).includes("private-input"), false);
  assert.equal(child.alive(), false);
});

test("observer errors cannot interrupt native cleanup or expose their message", { timeout: SDK_TEST_TIMEOUT_MS }, async t => {
  const child = fakeCli(t, "normal");
  const warnings: string[] = [];
  const emitWarning = process.emitWarning;
  process.emitWarning = ((message: string | Error) => warnings.push(String(message))) as typeof process.emitWarning;
  t.after(() => { process.emitWarning = emitWarning; });
  let calls = 0;
  const { events } = await child.thread.runStreamed("input", { onLifecycleEvent: () => {
    calls++;
    throw new Error("private-observer-error");
  } });
  for await (const _event of events) { /* consume native output */ }
  assert.ok(calls >= 4);
  assert.equal(warnings.length, calls);
  assert.ok(warnings.every(message => message === "Codex lifecycle observer failed"));
  assert.equal(child.alive(), false);
});

test("abort bounds cleanup when an exited CLI leaves inherited stdout and stderr open", { timeout: SDK_TEST_TIMEOUT_MS }, async t => {
  const child = fakeCli(t, "inherited-pipes-hang");
  const abort = new AbortController();
  const lifecycle: CodexLifecycleEvent[] = [];
  let observeExit!: () => void;
  const exited = new Promise<void>(resolve => { observeExit = resolve; });
  const { events } = await child.thread.runStreamed("input", { signal: abort.signal,
    onLifecycleEvent: event => {
      lifecycle.push(event);
      if (event.type === "child_exit") observeExit();
    } });
  const finished = (async () => { for await (const _event of events) { /* consume native output */ } })();
  await exited;
  assert.equal(child.alive(), false);
  const descendantPid = Number(fs.readFileSync(path.join(child.directory, "descendant-pid"), "utf8"));
  process.kill(descendantPid, 0);
  assert.equal(lifecycle.some(event => event.type === "child_close"), false);
  abort.abort();
  await finished;
  const names = lifecycle.map(event => event.type);
  assert.ok(names.indexOf("child_exit") < names.indexOf("termination_requested"));
  assert.ok(names.indexOf("termination_escalated") < names.indexOf("stdio_forced_closed"));
  assert.ok(names.indexOf("stdio_forced_closed") < names.indexOf("child_close"));
  assert.equal(names.at(-1), "cleanup_finished");
  // Draining finishes by closing our pipe endpoints, without waiting for the descendant.
  process.kill(descendantPid, 0);
});

test("spawn failure and pre-aborted turns settle without waiting for a missing exit event", { timeout: SDK_TEST_TIMEOUT_MS }, async t => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sdk-missing-cli-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const missing = new Codex({ codexPathOverride: path.join(directory, "missing") }).startThread();
  const { events } = await missing.runStreamed("input");
  await assert.rejects(async () => { for await (const _event of events) { /* consume native output */ } }, /ENOENT/);
  const child = fakeCli(t, "ignore-term");
  const aborted = await child.thread.runStreamed("input", { signal: AbortSignal.abort() });
  await assert.rejects(async () => { for await (const _event of aborted.events) { /* consume native output */ } }, /abort/i);
});
