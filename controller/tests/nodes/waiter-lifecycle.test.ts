import { afterEach, expect, it, vi } from "vitest";
import { NodeHub } from "../../src/nodes/hub.js";
import { MemoryStore } from "../../src/store/memory.js";

afterEach(() => { vi.useRealTimers(); });

it("cancel settles an existing wait immediately and clears its timer", async () => {
  vi.useFakeTimers();
  const hub = new NodeHub(new MemoryStore(), new Map());
  const waiter = hub.registerCommandResultWaiter("command");
  let settled = false;
  void waiter.wait().then(value => { expect(value).toBeNull(); settled = true; });
  waiter.cancel();
  await Promise.resolve();
  expect(settled).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  await hub.closeAll();
});

it("shutdown releases all waits without waiting for their deadlines", async () => {
  vi.useFakeTimers();
  const hub = new NodeHub(new MemoryStore(), new Map());
  const resolved: unknown[] = [];
  for (const id of ["first", "second"]) {
    void hub.registerCommandResultWaiter(id).wait().then(value => resolved.push(value));
  }
  await hub.closeAll();
  await Promise.resolve();
  expect(resolved).toEqual([null, null]);
  expect(vi.getTimerCount()).toBe(0);
});

it("replacing a waiter settles the old wait and its cancellation cannot remove the replacement", async () => {
  vi.useFakeTimers();
  const hub = new NodeHub(new MemoryStore(), new Map());
  const first = hub.registerCommandResultWaiter("same");
  let firstDone = false;
  let secondDone = false;
  void first.wait().then(() => { firstDone = true; });
  const second = hub.registerCommandResultWaiter("same");
  void second.wait().then(() => { secondDone = true; });
  await Promise.resolve();
  expect(firstDone).toBe(true);
  expect(secondDone).toBe(false);
  first.cancel();
  await hub.closeAll();
  await Promise.resolve();
  expect(secondDone).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("deadline expiry still settles once without retaining a timer", async () => {
  vi.useFakeTimers();
  const hub = new NodeHub(new MemoryStore(), new Map());
  const waiter = hub.registerCommandResultWaiter("expires", 100);
  await vi.advanceTimersByTimeAsync(100);
  expect(await waiter.wait()).toBeNull();
  waiter.cancel();
  expect(vi.getTimerCount()).toBe(0);
  await hub.closeAll();
});
