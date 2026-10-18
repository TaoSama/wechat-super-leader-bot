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
