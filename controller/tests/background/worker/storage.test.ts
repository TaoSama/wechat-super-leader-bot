import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { hash, WorkerStorage } from "../../../src/background/worker/storage.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-slot-test-")); roots.push(root);
 const store = new WorkerStorage(path.join(root, "workers"), path.join(root, "artifacts"));
 const slot = path.join(store.root, "slots", "0.json");
 return { root, store, slot };
}
describe("durable global execution capacity", () => {
 it("quarantines the entire damaged worker without publishing its other valid queued receipt", () => {
  const f = fixture();
  const badWorkerId = randomUUID();
  const healthyWorkerId = randomUUID();
  const healthyInvocationId = randomUUID();
  for (const [workerId, invocationId] of [[badWorkerId, "00000000-0000-4000-8000-000000000001"], [healthyWorkerId, healthyInvocationId]]) {
   const dir = f.store.worker(workerId, true)!;
   const pendingInput = { workerId, invocationId, task: "read observations", input: {} };
   f.store.save(dir, { workerId, invocationId, inputHash: hash(JSON.stringify(pendingInput)), ownerPid: process.pid,
    status: "queued", summary: "queued", attachments: [], pendingInput });
  }
  const damagedInvocation = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const badDir = f.store.worker(badWorkerId)!;
  const damagedFile = f.store.receiptPath(badDir, damagedInvocation);
  fs.writeFileSync(damagedFile, "{private broken receipt");
  const diagnostics: Error[] = [];
  expect(f.store.queued(error => diagnostics.push(error)).map(receipt => receipt.workerId)).toEqual([healthyWorkerId]);
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0].message).toContain(badWorkerId);
  expect(diagnostics[0].message).not.toContain("private");
  expect(() => f.store.receipt(badDir, damagedInvocation)).toThrow();
  expect(fs.readFileSync(damagedFile, "utf8")).toBe("{private broken receipt");
 });
 it("recovers a dead slot after the previous reaper crashed with its atomic claim held", () => {
  const f = fixture(); const token = randomUUID();
  fs.writeFileSync(f.slot, JSON.stringify({ ownerPid: 2147483647, token }));
  const firstClaim = path.join(path.dirname(f.slot), `reap-${hash(`${f.slot}:${token}`)}.lock`);
  fs.symlinkSync(`2147483647:${randomUUID()}:held`, firstClaim);
  expect(f.store.slot(1, randomUUID(), randomUUID())).toBe(f.slot);
  expect(JSON.parse(fs.readFileSync(f.slot, "utf8")).ownerPid).toBe(process.pid);
 });
 it("does not reap a quarantined slot after the CLI owner and process are gone", () => {
  const f = fixture();
  fs.writeFileSync(f.slot, JSON.stringify({ ownerPid: 2147483647, processPid: 2147483647, token: randomUUID(), cleanupUnverified: true }));
  expect(f.store.slot(1, randomUUID(), randomUUID())).toBeUndefined();
 });
 it("does not enter an old generation while another reaper owns its live claim", () => {
  const f = fixture(); const token = randomUUID();
  fs.writeFileSync(f.slot, JSON.stringify({ ownerPid: 2147483647, token }));
  const firstClaim = path.join(path.dirname(f.slot), `reap-${hash(`${f.slot}:${token}`)}.lock`);
  fs.symlinkSync(`${process.pid}:${randomUUID()}:held`, firstClaim);
  expect(f.store.slot(1, randomUUID(), randomUUID())).toBeUndefined();
  expect(JSON.parse(fs.readFileSync(f.slot, "utf8")).ownerPid).toBe(2147483647);
 });
});
