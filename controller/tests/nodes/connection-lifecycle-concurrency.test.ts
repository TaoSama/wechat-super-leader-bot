import { expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { ControllerCommandMessage } from "../../src/types.js";
import { barrier, captureLifecycle, connect, createHub, hello, session } from "./connection-lifecycle-fixture.js";

it("reports in-memory hello before slow or failed persistence without reporting durable success", async () => {
  const { events, errors } = captureLifecycle(), { hub, store } = createHub(), gate = barrier();
  const write = vi.spyOn(store, "upsertNodeSessions").mockImplementationOnce(async () => {
    await gate.promise;
    throw new Error("synthetic persistence failure");
  });
  try {
    connect(hub).receive(hello());
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    expect(hub.isNodeConnected("node")).toBe(true);
    expect(events().map(event => event.event)).toEqual(["connection_accepted", "hello_accepted"]);
    expect(await store.getKnownSession("node", "session")).toBeNull();
    connect(hub);
    expect(events().find(event => event.event === "connection_rejected")!.occupyingHelloAccepted).toBe(true);
    gate.release();
    await vi.waitFor(() => expect(errors).toHaveBeenCalledWith("[node] Error upserting node sessions on hello:", expect.any(Error)));
    expect(events().filter(event => String(event.event).includes("persist"))).toEqual([]);
    expect(hub.isNodeConnected("node")).toBe(true);
  } finally { gate.release(); }
});

it("logs replacement at the map update and never releases the new slot on an old late close", async () => {
  const { events } = captureLifecycle(), { hub, store } = createHub(), old = connect(hub, "node", false);
  const remove = vi.spyOn(store, "removeNodeSessions");
  old.receive(hello("node", [session("old")]));
  await vi.waitFor(async () => expect(await store.getKnownSession("node", "old")).not.toBeNull());
  const oldId = events()[0].connectionId;
  old.readyState = WebSocket.CLOSING;
  const replacement = connect(hub);
  replacement.receive(hello("node", [session("replacement")]));
  await vi.waitFor(async () => expect(await store.getKnownSession("node", "replacement")).not.toBeNull());
  const newAccepted = events().filter(event => event.event === "connection_accepted")[1];
  expect(events().find(event => event.event === "node_slot_released")).toMatchObject({
    connectionId: oldId, generation: 1, cause: "replacement", replacementConnectionId: newAccepted.connectionId,
  });
  old.finishClose(1006);
  expect(events().find(event => event.event === "socket_closed")).toMatchObject({
    connectionId: oldId, generation: 1, isCurrentSlot: false, hubCloseAttemptSeen: false,
  });
  expect(events().filter(event => event.event === "node_slot_released")).toHaveLength(1);
  expect(remove).not.toHaveBeenCalled();
  expect(hub.isNodeConnected("node")).toBe(true);
  expect((await hub.getAllSessions()).map(item => item.id)).toEqual(["replacement"]);
  connect(hub);
  expect(events().find(event => event.event === "connection_rejected")).toMatchObject({
    occupyingConnectionId: newAccepted.connectionId, occupyingGeneration: 2,
  });
});

it("releases the old slot before storage cleanup and preserves a new generation across the queued cleanup", async () => {
  const { events } = captureLifecycle(), { hub, store } = createHub(), gate = barrier();
  const originalRemove = store.removeNodeSessions.bind(store);
  const remove = vi.spyOn(store, "removeNodeSessions").mockImplementationOnce(async nodeId => {
    await gate.promise;
    await originalRemove(nodeId);
  });
  const uncertain = vi.spyOn(store, "markNodeActiveCommandsUncertain");
  try {
    const old = connect(hub);
    old.receive(hello("node", [session("old")]));
    await vi.waitFor(async () => expect(await store.getKnownSession("node", "old")).not.toBeNull());
    old.finishClose();
    expect(events().filter(event => event.event === "node_slot_released")).toHaveLength(1);
    expect(hub.getNodeStatusList()).toEqual([]);
    await vi.waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
    connect(hub).receive(hello("node", [session("new")]));
    expect(hub.isNodeConnected("node")).toBe(true);
    expect(events().filter(event => event.event === "hello_accepted").map(event => event.generation)).toEqual([1, 2]);
    expect(await store.getKnownSession("node", "new")).toBeNull();
    gate.release();
    await vi.waitFor(async () => expect(await store.getKnownSession("node", "new")).not.toBeNull());
    expect(uncertain).not.toHaveBeenCalled();
  } finally { gate.release(); }
});

it("records shutdown clear before close, and rejects reconnects while the original cleanup is pending", async () => {
  const { events } = captureLifecycle(), { hub, store } = createHub(), gate = barrier();
  const originalRemove = store.removeNodeSessions.bind(store);
  const remove = vi.spyOn(store, "removeNodeSessions").mockImplementationOnce(async nodeId => {
    await gate.promise;
    await originalRemove(nodeId);
  });
  let closing: Promise<void> | undefined;
  try {
    connect(hub).receive(hello());
    closing = hub.closeAll();
    const shutdownEvents = events().slice(2);
    expect(shutdownEvents.map(event => event.event)).toEqual(["node_slot_released", "close_requested", "socket_closed"]);
    expect(shutdownEvents[0].cause).toBe("shutdown");
    expect(shutdownEvents[2]).toMatchObject({ isCurrentSlot: false, hubStopping: true, hubCloseAttemptSeen: true });
    await vi.waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
    const reconnect = connect(hub);
    expect(reconnect.closeCalls).toEqual([{ code: 1001, reason: "Server shutting down" }]);
    expect(events().find(event => event.event === "connection_rejected")).toMatchObject({ cause: "server_stopping", generation: null });
    expect(events().filter(event => event.event === "node_slot_released")).toHaveLength(1);
    expect(hub.getNodeStatusList()).toEqual([]);
  } finally { gate.release(); await closing; }
});

it("does not invent a Hub close attempt when command transport terminates a pending socket during shutdown", async () => {
  const { events } = captureLifecycle(), { hub } = createHub(), socket = connect(hub);
  socket.receive(hello());
  vi.spyOn(socket, "send").mockImplementation(() => undefined);
  const command: ControllerCommandMessage = { type: "command", commandId: "fixture-command", nodeId: "node",
    sessionId: "session", action: "send", prompt: "fixture only", sendRoute: "control-socket",
    expiresAt: new Date(Date.now() + 300_000).toISOString() };
  const pending = hub.sendCommand(command);
  await hub.closeAll();
  expect(await pending).toMatchObject({ delivered: false, error: "Command transport stopped" });
  expect(events().find(event => event.event === "socket_closed")).toMatchObject({
    closeCode: 1006, isCurrentSlot: true, hubStopping: true, hubCloseAttemptSeen: false,
  });
  expect(events().filter(event => event.event === "close_requested")).toEqual([]);
  expect(events().filter(event => event.event === "node_slot_released")).toHaveLength(1);
  expect(events().find(event => event.event === "node_slot_released")!.cause).toBe("socket_close");
});
