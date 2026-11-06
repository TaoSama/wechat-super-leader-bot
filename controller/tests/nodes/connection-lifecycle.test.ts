import { expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { MAX_DAEMON_CONTROL_MESSAGE_BYTES } from "../../src/types.js";
import { captureLifecycle, connect, createHub, heartbeat, hello, session } from "./connection-lifecycle-fixture.js";

const WATCHDOG_MS = 45_000;
const REVISION = "45ab5965393f5fcc1cbadee08df07bd8a226f6d8";

it("correlates accept, in-memory hello, watchdog attempt, observed close and actual slot release", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  vi.stubEnv("SOURCE_REVISION", REVISION);
  const { events } = captureLifecycle(), { hub } = createHub(), socket = connect(hub);
  socket.receive(hello());
  await vi.advanceTimersByTimeAsync(WATCHDOG_MS - 1);
  expect(events().map(event => event.event)).toEqual(["connection_accepted", "hello_accepted"]);
  expect(hub.isNodeConnected("node")).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  const records = events();
  expect(records.map(event => event.event)).toEqual([
    "connection_accepted", "hello_accepted", "close_requested", "socket_closed", "node_slot_released",
  ]);
  expect(new Set(records.map(event => event.connectionId)).size).toBe(1);
  expect(records.map(event => event.eventSequence)).toEqual([1, 2, 3, 4, 5]);
  expect(records.every(event => event.generation === 1 && event.sourceRevision === REVISION)).toBe(true);
  expect(records[0].helloAccepted).toBe(false);
  expect(records[1].helloAccepted).toBe(true);
  expect(records[2]).toMatchObject({ cause: "heartbeat_timeout", requestedCode: 4008, timeoutMs: WATCHDOG_MS,
    watchdogResetAgeMs: WATCHDOG_MS, watchdogResetKind: "schema_message", connectionAgeMs: WATCHDOG_MS });
  expect(records[3]).toMatchObject({ closeCode: 4008, isCurrentSlot: true, hubStopping: false,
    hubCloseAttemptSeen: true, firstHubCloseCause: "heartbeat_timeout" });
  expect(records[4].cause).toBe("socket_close");
  expect(socket.closeCalls).toEqual([{ code: 4008, reason: "Heartbeat timeout" }]);
  expect(hub.getNodeStatusList()).toEqual([]);
});

it("assigns rejected attempts independent IDs without consuming accepted generations or mutating the occupant", () => {
  const { events } = captureLifecycle(), { hub } = createHub(), original = connect(hub);
  const first = connect(hub);
  expect(events().find(event => event.event === "connection_rejected")).toMatchObject({
    generation: null, occupyingGeneration: 1, occupyingHelloAccepted: false, occupyingSocketState: "open",
  });
  original.receive(hello());
  const second = connect(hub);
  const accepted = events().find(event => event.event === "connection_accepted")!;
  const rejected = events().filter(event => event.event === "connection_rejected");
  expect(new Set([accepted, ...rejected].map(event => event.connectionId)).size).toBe(3);
  expect(rejected.every(event => event.occupyingConnectionId === accepted.connectionId)).toBe(true);
  expect(rejected[1]).toMatchObject({ occupyingHelloAccepted: true, occupyingGeneration: 1, generation: null });
  expect([first, second].map(socket => socket.closeCalls[0].code)).toEqual([4009, 4009]);
  expect(events().filter(event => event.event === "node_slot_released")).toEqual([]);
  expect(hub.isNodeConnected("node")).toBe(true);
  expect(original.closeCalls).toEqual([]);
  original.finishClose();
  connect(hub).receive(hello());
  expect(events().filter(event => event.event === "connection_accepted").map(event => event.generation)).toEqual([1, 2]);
});

it("keeps high-frequency heartbeats and qualified pings silent while preserving the liveness deadline", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  const { events } = captureLifecycle(), { hub } = createHub(), socket = connect(hub);
  socket.receive(hello());
  for (let i = 0; i < 100; i++) socket.receive(heartbeat);
  for (let i = 0; i < 8; i++) {
    await vi.advanceTimersByTimeAsync(15_000);
    socket.ping();
  }
  expect(socket.readyState).toBe(WebSocket.OPEN);
  expect(events()).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(WATCHDOG_MS - 1);
  expect(events()).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(events().find(event => event.event === "close_requested")).toMatchObject({
    watchdogResetKind: "ping", watchdogResetAgeMs: WATCHDOG_MS, requestedCode: 4008,
  });
});

it("does not classify pre-hello pings as a watchdog reset", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  const { events } = captureLifecycle(), { hub } = createHub(), socket = connect(hub);
  await vi.advanceTimersByTimeAsync(30_000);
  socket.ping();
  await vi.advanceTimersByTimeAsync(15_000);
  expect(events().find(event => event.event === "close_requested")).toMatchObject({
    helloAccepted: false, watchdogResetKind: "initial", watchdogResetAgeMs: WATCHDOG_MS,
  });
});

it("records attempts separately from observed close codes without deciding who initiated closure", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  const { events } = captureLifecycle(), { hub } = createHub(), socket = connect(hub, "node", false);
  socket.receive(hello());
  await vi.advanceTimersByTimeAsync(WATCHDOG_MS);
  expect(events().some(event => event.event === "socket_closed")).toBe(false);
  expect(hub.getNodeStatusList()).toHaveLength(1);
  socket.finishClose(1006);
  expect(events().find(event => event.event === "socket_closed")).toMatchObject({
    closeCode: 1006, hubCloseAttemptSeen: true, firstHubCloseCause: "heartbeat_timeout",
  });
});

it("logs only whitelisted metadata, omits peer-controlled data, and records each socket's first error only", () => {
  const secret = "secret-token-payload-192.0.2.18";
  vi.stubEnv("SOURCE_REVISION", secret);
  const { events, errors } = captureLifecycle(), { hub } = createHub(), socket = connect(hub);
  socket.receive(hello("node", [session(secret)]));
  socket.emit("error", new Error(secret));
  socket.emit("error", new Error(`${secret}-again`));
  socket.finishClose(1000, secret);
  expect(errors).toHaveBeenCalledTimes(2);
  expect(events().filter(event => event.event === "socket_error")).toHaveLength(1);
  expect(events().find(event => event.event === "socket_closed")).toMatchObject({ closeCode: 1000, hubCloseAttemptSeen: false });
  const allowed = new Set(["schemaVersion", "event", "atUTC", "eventSequence", "hubId", "connectionId", "nodeId",
    "generation", "socketState", "sourceRevision", "connectionAgeMs", "helloAccepted", "watchdogResetAgeMs",
    "watchdogResetKind", "closeCode", "isCurrentSlot", "hubStopping", "hubCloseAttemptSeen", "cause"]);
  expect(events().every(event => Object.keys(event).every(key => allowed.has(key)) && event.sourceRevision === "unknown")).toBe(true);
  expect(JSON.stringify(events())).not.toContain(secret);
  expect(JSON.stringify(events())).not.toMatch(/peer.initiated|error.message|reason|token|payload|192\.0\.2/);
});

it("uses distinct Hub namespaces and monotonic ages even if the wall clock moves backwards", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  const { events } = captureLifecycle();
  const first = createHub(), second = createHub();
  const socket = connect(first.hub);
  connect(second.hub);
  expect(new Set(events().map(event => event.hubId)).size).toBe(2);
  expect(new Set(events().map(event => event.connectionId)).size).toBe(2);
  await vi.advanceTimersByTimeAsync(100);
  vi.setSystemTime(new Date("2000-01-01T00:00:00Z"));
  socket.finishClose();
  expect(events().find(event => event.event === "socket_closed")!.connectionAgeMs).toBe(100);
});

it.each([
  { name: "pre-hello heartbeat", prime: false, message: heartbeat, code: 4002, cause: "message_before_hello", reason: "Message before hello handshake" },
  { name: "mismatched hello", prime: false, message: hello("other"), code: 4003, cause: "node_identity_mismatch", reason: "Node ID mismatch with authenticated identity" },
  { name: "repeated hello", prime: true, message: hello(), code: 4000, cause: "repeated_hello", reason: "Repeated hello message rejected" },
  { name: "malformed inventory", prime: true, message: { ...heartbeat, sessions: null }, code: 4000, cause: "invalid_session_inventory", reason: "Invalid session inventory" },
  { name: "conflicting inventory", prime: true, message: { ...heartbeat, sessions: [session("same"), session("same")] }, code: 4000, cause: "invalid_session_inventory", reason: "Invalid session inventory" },
  { name: "oversized control message", prime: true, message: { padding: "x".repeat(MAX_DAEMON_CONTROL_MESSAGE_BYTES) }, code: 4000, cause: "control_message_too_large", reason: "Daemon control message exceeds limit" },
])("observes $name without changing its close contract", ({ prime, message, code, cause, reason }) => {
  const { events } = captureLifecycle(), { hub } = createHub(), socket = connect(hub);
  if (prime) socket.receive(hello());
  socket.receive(message);
  expect(socket.closeCalls).toEqual([{ code, reason }]);
  expect(events().find(event => event.event === "close_requested")).toMatchObject({ requestedCode: code, cause });
  expect(events().filter(event => event.event === "node_slot_released")).toHaveLength(1);
  expect(hub.getNodeStatusList()).toEqual([]);
});
