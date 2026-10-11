import { EventEmitter } from "node:events";
import type { Response } from "express";
import { afterEach, expect, it, vi } from "vitest";
import { StatusEvents, STATUS_AUTH_INTERVAL_MS, STATUS_AUTH_DEADLINE_MS, STATUS_COALESCE_MS, STATUS_MAX_CONNECTIONS } from "../src/status-events.js";

class StreamResponse extends EventEmitter {
  frames: string[] = [];
  headers: Record<string, string> = {};
  writableLength = 0;
  statusCode = 0;
  ended = false;
  slow = false;
  destroyed = false;
  status(code: number) { this.statusCode = code; return this; }
  set(headers: Record<string, string>) { this.headers = headers; return this; }
  flushHeaders() {}
  json() { this.ended = true; }
  write(frame: string) { this.frames.push(frame); return !this.slow; }
  end() { this.ended = true; }
  destroy() { this.destroyed = true; this.ended = true; }
  asResponse() { return this as unknown as Response; }
}

afterEach(() => vi.useRealTimers());

it("coalesces all clients into one snapshot, deduplicates unchanged data and releases disconnected streams", async () => {
  vi.useFakeTimers();
  let revision = 1;
  const load = vi.fn(async () => ({ revision }));
  const events = new StatusEvents(load);
  const clients = [new StreamResponse(), new StreamResponse()];
  for (const client of clients) events.open(client.asResponse(), async () => true);
  await vi.advanceTimersByTimeAsync(STATUS_COALESCE_MS);
  expect(load).toHaveBeenCalledTimes(1);
  expect(clients[0].frames).toEqual(["event: status\ndata: {\"revision\":1}\n\n"]);
  events.changed();
  events.changed();
  revision = 2;
  await vi.advanceTimersByTimeAsync(STATUS_COALESCE_MS);
  expect(load).toHaveBeenCalledTimes(2);
  expect(clients[0].frames).toHaveLength(2);
  events.changed();
  await vi.advanceTimersByTimeAsync(STATUS_COALESCE_MS);
  expect(clients[0].frames).toHaveLength(2);
  for (const client of clients) client.emit("close");
  const count = load.mock.calls.length;
  await vi.advanceTimersByTimeAsync(STATUS_AUTH_INTERVAL_MS * 2);
  expect(load).toHaveBeenCalledTimes(count);
  expect(vi.getTimerCount()).toBe(0);
  events.stop();
});

it("shares even a slow snapshot and processes changes that arrived while it was loading", async () => {
  vi.useFakeTimers();
  let resolve!: (value: { revision: number }) => void;
  const load = vi.fn(() => new Promise<{ revision: number }>(done => { resolve = done; }));
  const events = new StatusEvents(load);
  const client = new StreamResponse();
  events.open(client.asResponse(), async () => true);
  await vi.advanceTimersByTimeAsync(STATUS_COALESCE_MS);
  const httpRead = events.readSnapshot();
  events.changed();
  await vi.advanceTimersByTimeAsync(STATUS_COALESCE_MS * 5);
  expect(load).toHaveBeenCalledTimes(1);
  resolve({ revision: 1 });
  await httpRead;
  await vi.advanceTimersByTimeAsync(STATUS_COALESCE_MS);
  expect(load).toHaveBeenCalledTimes(2);
  resolve({ revision: 2 });
  await vi.advanceTimersByTimeAsync(0);
  expect(client.frames).toHaveLength(2);
  events.stop();
});

it.each(["expiry", "external revocation"])("independently rechecks %s within 5 seconds without node changes", async () => {
  vi.useFakeTimers();
  let valid = true;
  const verify = vi.fn(async () => valid);
  const events = new StatusEvents(async () => ({ confidential: "snapshot" }));
  const client = new StreamResponse();
  events.open(client.asResponse(), verify, "session");
  await vi.advanceTimersByTimeAsync(STATUS_COALESCE_MS);
  valid = false;
  await vi.advanceTimersByTimeAsync(STATUS_AUTH_INTERVAL_MS);
  expect(client.ended).toBe(true);
  expect(client.frames.at(-1)).toBe("event: auth-expired\ndata: {}\n\n");
  expect(client.frames.filter(frame => frame.includes("confidential"))).toHaveLength(1);
  const checks = verify.mock.calls.length;
  events.changed();
  await vi.advanceTimersByTimeAsync(STATUS_AUTH_INTERVAL_MS);
  expect(verify).toHaveBeenCalledTimes(checks);
  expect(vi.getTimerCount()).toBe(0);
  events.stop();
});

it("logout closes immediately and cannot leak a pending snapshot after revocation", async () => {
  vi.useFakeTimers();
  let resolve!: (value: { secret: string }) => void;
  const events = new StatusEvents(() => new Promise<{ secret: string }>(done => { resolve = done; }));
  const client = new StreamResponse();
  events.open(client.asResponse(), async () => true, "session");
  await vi.advanceTimersByTimeAsync(STATUS_COALESCE_MS);
  events.revoke("session");
  resolve({ secret: "must-not-leak" });
  await vi.advanceTimersByTimeAsync(0);
  expect(client.ended).toBe(true);
  expect(client.frames).toEqual(["event: auth-expired\ndata: {}\n\n"]);
  events.stop();
});

it("bounds connections, retains only the latest snapshot for slow clients and destroys blocked streams at shutdown", async () => {
  vi.useFakeTimers();
  let revision = 0;
  const events = new StatusEvents(async () => ({ revision: revision++ }));
  const clients = Array.from({ length: STATUS_MAX_CONNECTIONS }, () => new StreamResponse());
  clients[0].slow = true;
  for (const client of clients) events.open(client.asResponse(), async () => true);
  const rejected = new StreamResponse();
  events.open(rejected.asResponse(), async () => true);
  expect(rejected.statusCode).toBe(503);
  await vi.advanceTimersByTimeAsync(STATUS_COALESCE_MS);
  events.changed();
  await vi.advanceTimersByTimeAsync(STATUS_COALESCE_MS);
  expect(clients[0].frames).toHaveLength(1);
  clients[0].slow = false;
  clients[0].emit("drain");
  await vi.advanceTimersByTimeAsync(STATUS_COALESCE_MS);
  expect(clients[0].frames.at(-1)).toContain('"revision":2');
  clients[1].slow = true;
  events.changed();
  await vi.advanceTimersByTimeAsync(STATUS_COALESCE_MS);
  events.stop();
  expect(clients.every(client => client.ended)).toBe(true);
  expect(clients[1].destroyed).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("closes a client that never drains within the heartbeat interval", async () => {
  vi.useFakeTimers();
  const events = new StatusEvents(async () => ({ revision: 1 }));
  const client = new StreamResponse();
  client.slow = true;
  events.open(client.asResponse(), async () => true);
  await vi.advanceTimersByTimeAsync(STATUS_AUTH_INTERVAL_MS);
  expect(client.destroyed).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("fails closed if authorization storage fails without exposing the failure", async () => {
  vi.useFakeTimers();
  const events = new StatusEvents(async () => ({ sensitive: "never-send" }));
  const client = new StreamResponse();
  events.open(client.asResponse(), async () => { throw new Error("private database details"); });
  await vi.advanceTimersByTimeAsync(STATUS_COALESCE_MS);
  expect(client.ended).toBe(true);
  expect(client.frames).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});

it("rejects oversized snapshots before buffering them in a client socket", async () => {
  vi.useFakeTimers();
  const events = new StatusEvents(async () => ({ output: "x".repeat(1024 * 1024) }));
  const client = new StreamResponse();
  events.open(client.asResponse(), async () => true);
  await vi.advanceTimersByTimeAsync(STATUS_COALESCE_MS);
  expect(client.ended).toBe(true);
  expect(client.frames).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});

it("a hung verifier fails closed within 5 seconds without blocking healthy clients' subsequent revisions", async () => {
  vi.useFakeTimers();
  let revision = 1;
  let hang = false;
  const events = new StatusEvents(async () => ({ revision }));
  const healthy = new StreamResponse();
  const stalled = new StreamResponse();
  events.open(healthy.asResponse(), async () => true);
  events.open(stalled.asResponse(), () => hang ? new Promise<boolean>(() => {}) : Promise.resolve(true));
  await vi.advanceTimersByTimeAsync(STATUS_COALESCE_MS);
  expect(stalled.frames[0]).toContain('"revision":1');
  hang = true;
  revision = 2;
  events.changed();
  await vi.advanceTimersByTimeAsync(STATUS_COALESCE_MS);
  expect(healthy.frames.at(-1)).toContain('"revision":2');
  revision = 3;
  events.changed();
  await vi.advanceTimersByTimeAsync(STATUS_COALESCE_MS);
  expect(healthy.frames.at(-1)).toContain('"revision":3');
  expect(stalled.ended).toBe(false);
  await vi.advanceTimersByTimeAsync(STATUS_AUTH_DEADLINE_MS - STATUS_COALESCE_MS);
  expect(stalled.ended).toBe(true);
  expect(stalled.frames.at(-1)).toBe("event: auth-expired\ndata: {}\n\n");
  expect(stalled.frames.some(frame => frame.includes('"revision":3'))).toBe(false);
  revision = 4;
  events.changed();
  await vi.advanceTimersByTimeAsync(STATUS_COALESCE_MS);
  expect(healthy.frames.at(-1)).toContain('"revision":4');
  events.stop();
  expect(vi.getTimerCount()).toBe(0);
});
