import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NotificationCycleDiagnostics } from "../../src/runtime/notification-diagnostics.js";
import { MAX_PENDING_FAILURES, NOTIFICATION_RECOVERY_EXPIRY_MS,
  NotificationRecoveryStore } from "../../src/runtime/notification-recovery-store.js";
import { RequestDiagnostics } from "../../src/runtime/request-diagnostics.js";
import { parseNotificationCycle } from "../fixtures/notification-cycle-log.js";

const PRIVATE = "private-token-account-message-url";
const START = Date.parse("2026-11-01T00:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
const active = () => true;
const reportable = () => true;

function socketError(): TypeError {
  return new TypeError(PRIVATE, { cause: Object.assign(new Error(PRIVATE), { code: "ECONNRESET", hostname: PRIVATE }) });
}
async function request(identity: string, fails: boolean): Promise<void> {
  const diagnostics = new RequestDiagnostics("result_get", identity);
  if (!fails) { diagnostics.success(); return; }
  const error = socketError(); diagnostics.failure(error, 1, 1, false); throw error;
}
class CountingStore extends NotificationRecoveryStore {
  writes = 0;
  override save(...args: Parameters<NotificationRecoveryStore["save"]>): void { this.writes++; super.save(...args); }
  override clear(): void { this.writes++; super.clear(); }
}
function setup(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notification-recovery-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "state.json.notification-recovery.json");
  const clock = { now: START };
  const start = (store: NotificationRecoveryStore = new CountingStore(file)) => {
    const events: Record<string, unknown>[] = [];
    const observer = new NotificationCycleDiagnostics(1000, event => {
      // Every emitted event must pass the CLI log field allowlist.
      assert.ok(parseNotificationCycle(JSON.stringify(event)));
      events.push(event);
    }, () => clock.now, store);
    const run = (action: () => Promise<unknown>) => observer.run(action, active, reportable);
    return { events, run, store, names: () => events.map(event => event.event) };
  };
  return { file, clock, start };
}

test("unresolved evidence survives a restart and recovers only after matching post-restart success", async t => {
  const f = setup(t), before = f.start();
  await assert.rejects(before.run(() => request("recipient-a", true)));
  f.clock.now += HOUR_MS;
  await assert.rejects(before.run(() => request("recipient-b", true)));
  await assert.rejects(before.run(() => request("recipient-a", true)));
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  const raw = fs.readFileSync(f.file, "utf8"), saved = JSON.parse(raw);
  assert.ok(!raw.includes(PRIVATE) && !raw.includes("recipient-"));
  assert.equal(saved.unresolved.length, 2);
  assert.ok(saved.unresolved.every((item: Record<string, unknown>) => /^[a-f0-9]{64}$/.test(item.identityHash as string)));
  assert.deepEqual(saved.unresolved.map((item: Record<string, unknown>) => item.count), [2, 1]);
  assert.deepEqual(saved.unresolved[0].causeCodes, ["ECONNRESET"]);

  f.clock.now += HOUR_MS;
  const after = f.start();
  await after.run(async () => ({ skipped: 1 }));
  assert.deepEqual(after.names(), ["notification_cycle_restored"]);
  assert.equal(after.events[0].unresolvedFailures, 2);
  assert.equal(after.events[0].totalFailures, 3);
  assert.equal(after.events[0].ageMs, 2 * HOUR_MS);
  assert.equal(after.events[0].lastFailureAgeMs, HOUR_MS);
  await after.run(() => request("recipient-a", false));
  await after.run(() => request("recipient-c", false));
  assert.equal(after.events.length, 1, "partial or unrelated success is not recovery");
  await after.run(() => request("recipient-b", false));
  assert.deepEqual(after.names(), ["notification_cycle_restored", "notification_cycle_recovered"]);
  assert.equal(after.events[1].totalFailures, 3);
  assert.deepEqual(after.events[1].recoveredOperations, ["result_get"]);
  assert.ok(!fs.existsSync(f.file), "recovered evidence is removed");
  assert.equal(f.start().events.length, 0);
});

test("expired evidence is dropped with a log and does not block readiness", async t => {
  const f = setup(t), before = f.start();
  await assert.rejects(before.run(() => request("recipient-a", true)));
  f.clock.now += NOTIFICATION_RECOVERY_EXPIRY_MS + 1;
  const after = f.start();
  await after.run(async () => ({}));
  assert.deepEqual(after.names(), ["notification_cycle_restore_discarded", "notification_cycle_ready"]);
  assert.equal(after.events[0].reason, "expired");
  assert.equal(after.events[0].ageMs, NOTIFICATION_RECOVERY_EXPIRY_MS + 1);
  assert.equal(after.events[0].unresolvedFailures, 1);
  assert.ok(!fs.existsSync(f.file));
});

test("corrupt or unsafe state is logged and replaced by fresh diagnostics without failing cycles", async t => {
  const f = setup(t), valid = f.start();
  await assert.rejects(valid.run(() => request("recipient-a", true)));
  const saved = JSON.parse(fs.readFileSync(f.file, "utf8"));
  const corruptions = ["{", "[]", JSON.stringify({ ...saved, version: 2 }),
    JSON.stringify({ ...saved, unresolved: [{ ...saved.unresolved[0], identityHash: PRIVATE }] }),
    JSON.stringify({ ...saved, unresolved: [{ ...saved.unresolved[0], causeCodes: [PRIVATE] }] }),
    JSON.stringify({ ...saved, unresolved: [{ ...saved.unresolved[0], operation: PRIVATE }] }),
    JSON.stringify({ ...saved, unresolved: Array.from({ length: MAX_PENDING_FAILURES + 1 }, () => saved.unresolved[0]) })];
  for (const content of corruptions) {
    fs.writeFileSync(f.file, content, { mode: 0o600 });
    const after = f.start();
    assert.equal(await after.run(async () => "value"), "value");
    assert.deepEqual(after.names(), ["notification_cycle_restore_discarded", "notification_cycle_ready"], content);
    assert.equal(after.events[0].reason, "invalid");
    assert.ok(!JSON.stringify(after.events).includes(PRIVATE));
    assert.ok(!fs.existsSync(f.file));
  }
  fs.mkdirSync(f.file);
  const unreadable = f.start();
  await assert.rejects(unreadable.run(() => request("recipient-a", true)), TypeError);
  assert.deepEqual(unreadable.names(), ["notification_cycle_restore_discarded", "notification_cycle_persist_failed",
    "notification_cycle_failed"]);
  await assert.rejects(unreadable.run(() => request("recipient-a", true)), TypeError);
  assert.equal(unreadable.names().filter(name => name === "notification_cycle_persist_failed").length, 1,
    "persistence failure is logged on transition only");
});

test("overflow is bounded, persisted and keeps recovery unproven after restart", async t => {
  const f = setup(t), before = f.start();
  await assert.rejects(before.run(async () => {
    const errors = Array.from({ length: MAX_PENDING_FAILURES + 1 }, (_, index) => {
      const error = socketError(); new RequestDiagnostics("result_get", `recipient-${index}`).failure(error, 1, 1, false);
      return error;
    });
    throw errors[0];
  }));
  const saved = JSON.parse(fs.readFileSync(f.file, "utf8"));
  assert.equal(saved.unresolved.length, MAX_PENDING_FAILURES);
  assert.equal(saved.recoveryEvidenceOverflow, true);
  const after = f.start();
  await after.run(async () => {
    for (let index = 0; index <= MAX_PENDING_FAILURES; index++) await request(`recipient-${index}`, false);
  });
  await after.run(async () => ({ skipped: 1 }));
  assert.deepEqual(after.names(), ["notification_cycle_restored"]);
  assert.equal(after.events[0].recoveryEvidenceOverflow, true);
  assert.equal(after.events[0].unresolvedFailures, MAX_PENDING_FAILURES);
});

test("steady successful cycles never write; only evidence changes do", async t => {
  const f = setup(t), steady = f.start(), store = steady.store as CountingStore;
  for (let index = 0; index < 5; index++) await steady.run(() => request("recipient-a", false));
  assert.equal(store.writes, 0);
  await assert.rejects(steady.run(() => request("recipient-a", true)));
  assert.equal(store.writes, 1);
  for (let index = 0; index < 5; index++) await steady.run(() => request("recipient-b", false));
  assert.equal(store.writes, 1, "unrelated success leaves unresolved evidence unchanged");
  await steady.run(() => request("recipient-a", false));
  assert.equal(store.writes, 2, "recovery clears the file once");
  for (let index = 0; index < 5; index++) await steady.run(() => request("recipient-a", false));
  assert.equal(store.writes, 2);
});

test("a failing store never changes cycle results", async t => {
  const f = setup(t);
  class BrokenStore extends NotificationRecoveryStore {
    override save(): void { throw Object.assign(new Error(PRIVATE), { code: "EACCES" }); }
  }
  const broken = f.start(new BrokenStore(f.file)), original = socketError();
  await assert.rejects(broken.run(async () => { throw original; }), error => error === original);
  assert.equal(await broken.run(async () => "value"), "value");
  assert.deepEqual(broken.names(), ["notification_cycle_failed", "notification_cycle_persist_failed"]);
  assert.deepEqual(broken.events[1].causeCodes, ["OtherCode"]);
  assert.ok(!JSON.stringify(broken.events).includes(PRIVATE));
});
