import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandService } from "../src/commands.js";
import { MemoryStore } from "../src/store/memory.js";
import { createExecution, executionRequestId, EXECUTION_CLAIM_MS, EXECUTION_PAGE_SIZE,
  EXECUTION_TICK_MS, EXECUTION_TTL_MS, type ExecutionRecord } from "../src/leader/execution.js";
import { ExecutionScheduler } from "../src/leader/execution-scheduler.js";
import type { Plan } from "../src/leader/contracts.js";
import type { PostCommandRequest, SendRoute, Session } from "../src/types.js";

const schedulers: ExecutionScheduler[] = [];
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
const drain = () => vi.advanceTimersByTimeAsync(0);
function plan(dependencies: number[][] = [[], [1]], sameSession = false): Plan {
  return { id: randomUUID(), expiresAt: Date.now() + 60_000, actions: dependencies.map((dependsOn, index) => ({
    nodeId: "node", sessionId: sameSession ? "session" : `session-${index}`,
    prompt: `step-${index + 1}`, dependsOn, sendRoute: "control-socket" as const,
  })) };
}
async function fixture(dependencies: number[][] = [[], [1]], sameSession = false) {
  const store = new MemoryStore();
  let now = Date.now();
  let allowed = true;
  let beforeGuard: (() => Promise<void>) | undefined;
  const execution = createExecution("chat", plan(dependencies, sameSession), now);
  await store.createExecutionIfAbsent(execution);
  const errors = vi.fn();
  const changed = vi.fn();
  const submit = vi.fn(async (input: PostCommandRequest, waitMs?: number, guard?: () => Promise<void>, route?: SendRoute) => {
    expect(waitMs).toBe(0);
    expect(input).not.toHaveProperty("sendRoute");
    const stamp = new Date(now).toISOString();
    const commandId = `command-${submit.mock.calls.length}`;
    const { command } = await store.createCommandIfAbsent({ ...input, commandId, sendRoute: route,
      status: "pending", createdAt: stamp, updatedAt: stamp, expiresAt: new Date(now + 60_000).toISOString() });
    if (beforeGuard) await beforeGuard();
    try { await guard?.(); }
    catch (error) { await store.updateCommandStatus(command.commandId, "failed", undefined, "authority revoked"); throw error; }
    await store.updateCommandStatus(command.commandId, "accepted", "received", undefined, `turn-${command.commandId}`);
    return (await store.getCommand(command.commandId))!;
  });
  const create = (commands: Pick<CommandService, "submit"> = { submit },
    canDispatch?: (execution: ExecutionRecord, index: number) => Promise<boolean> | boolean) => {
    const scheduler = new ExecutionScheduler(store, commands, { now: () => now, isChatAllowed: () => allowed,
      onError: errors, onChanged: changed, canDispatch });
    schedulers.push(scheduler);
    return scheduler;
  };
  const scheduler = create();
  const command = async (index: number) => (await store.findCommandByRequestId(executionRequestId(execution, index)))!;
  const reply = async (index: number, status: "completed" | "failed" | "uncertain") => {
    const record = await command(index);
    await store.updateCommandStatus(record.commandId, status, status === "completed" ? `output-${index}` : undefined,
      status === "uncertain" ? "disconnected" : undefined, record.turnId);
  };
  return { store, execution, scheduler, submit, create, errors, changed, command, reply,
    tick: (ms: number) => { now += ms; }, revoke: () => { allowed = false; },
    beforeGuard: (callback: () => Promise<void>) => { beforeGuard = callback; } };
}
afterEach(async () => {
  await Promise.all(schedulers.splice(0).map(scheduler => scheduler.stop()));
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Persistent execution scheduler", () => {
  it("runs independent roots, but accepted and pending never unlock a dependency", async () => {
    const f = await fixture([[], [], [1, 2]]);
    await f.scheduler.advance(f.execution.id);
    expect(f.submit).toHaveBeenCalledTimes(2);
    expect((await f.scheduler.view(f.execution.id, "chat"))?.steps.map(step => step.status)).toEqual(["accepted", "accepted", "waiting"]);
    await f.reply(0, "completed");
    await f.scheduler.advance(f.execution.id);
    expect(f.submit).toHaveBeenCalledTimes(2);
    await f.reply(1, "completed");
    await f.scheduler.advance(f.execution.id);
    expect(f.submit).toHaveBeenCalledTimes(3);
    await f.reply(2, "completed");
    await f.scheduler.advance(f.execution.id);
    expect((await f.scheduler.view(f.execution.id, "chat"))?.status).toBe("completed");
  });

  it("runs a same-session chain only after exact completion and never replays receipts", async () => {
    const f = await fixture([[], [1]], true);
    await f.scheduler.advance(f.execution.id);
    await f.scheduler.advance(f.execution.id);
    expect(f.submit).toHaveBeenCalledTimes(1);
    await f.reply(0, "completed");
    await f.scheduler.advance(f.execution.id);
    await f.scheduler.advance(f.execution.id);
    expect(f.submit).toHaveBeenCalledTimes(2);
    expect(f.submit.mock.calls[1][0].sessionId).toBe("session");
    expect(f.submit.mock.calls[1][0].requestId).toBe(executionRequestId(f.execution, 1));
  });

  it("leaves pending commands pending without submitting again or unlocking successors", async () => {
    const f = await fixture();
    await f.scheduler.advance(f.execution.id);
    const command = await f.command(0);
    vi.spyOn(f.store, "findCommandByRequestId").mockImplementation(async id =>
      id === command.requestId ? { ...command, status: "pending", turnId: undefined } : null);
    await f.create().advance(f.execution.id);
    expect((await f.scheduler.view(f.execution.id, "chat"))?.steps.map(step => step.status)).toEqual(["pending", "waiting"]);
    expect(f.submit).toHaveBeenCalledTimes(1);
  });

  it("expires unacknowledged pending commands without HTTP polling and pauses successors", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const submit = vi.fn(async (input: PostCommandRequest, _waitMs?: number, guard?: () => Promise<void>, route?: SendRoute) => {
      await guard?.();
      const stamp = new Date().toISOString();
      return (await f.store.createCommandIfAbsent({ ...input, commandId: "pending-command", status: "pending",
        sendRoute: route, createdAt: stamp, updatedAt: stamp, expiresAt: new Date(Date.now() + 60_000).toISOString() })).command;
    });
    const scheduler = f.create({ submit });
    await scheduler.advance(f.execution.id);
    vi.setSystemTime(Date.now() + 60_001);
    f.tick(60_001);
    await scheduler.advance(f.execution.id);
    expect((await scheduler.view(f.execution.id, "chat"))?.steps.map(step => step.status)).toEqual(["uncertain", "waiting"]);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("does not burn an attempt while read-only preflight is false, and claims once ready", async () => {
    const f = await fixture();
    let ready = false;
    const canDispatch = vi.fn(() => ready);
    const scheduler = f.create(undefined, canDispatch);
    await scheduler.advance(f.execution.id);
    expect((await f.store.getExecution(f.execution.id))?.attempts).toEqual([null, null]);
    expect(f.submit).not.toHaveBeenCalled();
    ready = true;
    await scheduler.advance(f.execution.id);
    expect(f.submit).toHaveBeenCalledTimes(1);
    expect(canDispatch.mock.calls).toHaveLength(2);
  });

  it("waits for an idle heartbeat after same-session completion before claiming the successor", async () => {
    const f = await fixture([[], [1]], true);
    let idle = false;
    const scheduler = f.create(undefined, (_execution, index) => index === 0 || idle);
    await scheduler.advance(f.execution.id);
    await f.reply(0, "completed");
    await scheduler.advance(f.execution.id);
    expect((await f.store.getExecution(f.execution.id))?.attempts[1]).toBeNull();
    expect((await scheduler.view(f.execution.id, "chat"))?.steps[1].status).toBe("waiting");
    idle = true;
    await scheduler.advance(f.execution.id);
    expect(f.submit).toHaveBeenCalledTimes(2);
  });

  it("rechecks cancellation after the awaited preflight before claiming", async () => {
    const f = await fixture();
    const scheduler = f.create(undefined, async () => {
      await f.scheduler.cancel(f.execution.id, "chat");
      return true;
    });
    await scheduler.advance(f.execution.id);
    expect((await f.store.getExecution(f.execution.id))?.attempts).toEqual([null, null]);
    expect(f.submit).not.toHaveBeenCalled();
  });

  it("pauses the entire plan on uncertainty, then resumes only exact successors after restart", async () => {
    const f = await fixture([[], [1], []]);
    await f.scheduler.advance(f.execution.id);
    await f.reply(0, "uncertain");
    const restarted = f.create();
    await restarted.advance(f.execution.id);
    expect(f.submit).toHaveBeenCalledTimes(2);
    await f.reply(0, "completed");
    await restarted.advance(f.execution.id);
    expect(f.submit).toHaveBeenCalledTimes(3);
    expect((await restarted.view(f.execution.id, "chat"))?.steps[0]).toMatchObject({ status: "completed", output: "output-0", turnId: "turn-command-1" });
    expect(f.submit.mock.calls.filter(([input]) => input.prompt === "step-1")).toHaveLength(1);
  });

  it("preserves a claim without a command, expires uncertain, and never retries it", async () => {
    const f = await fixture();
    const now = f.execution.createdAt;
    await f.store.compareAndSetExecution({ ...f.execution, revision: 2,
      attempts: [{ token: randomUUID(), startedAt: now, expiresAt: now + EXECUTION_CLAIM_MS }, null] }, 1);
    await f.scheduler.advance(f.execution.id);
    expect((await f.scheduler.view(f.execution.id, "chat"))?.steps.map(step => step.status)).toEqual(["claimed", "waiting"]);
    f.tick(EXECUTION_CLAIM_MS);
    await f.create().advance(f.execution.id);
    expect((await f.scheduler.view(f.execution.id, "chat"))?.steps.map(step => step.status)).toEqual(["uncertain", "waiting"]);
    expect(f.submit).not.toHaveBeenCalled();
    expect(JSON.stringify(await f.scheduler.view(f.execution.id, "chat"))).not.toContain("token");
  });

  it("does not trust an otherwise matching command without a persisted attempt", async () => {
    const f = await fixture();
    const action = f.execution.plan.actions[0], stamp = new Date().toISOString();
    await f.store.createCommandIfAbsent({ nodeId: action.nodeId, sessionId: action.sessionId, action: "send",
      prompt: action.prompt, sendRoute: action.sendRoute, requestId: executionRequestId(f.execution, 0),
      commandId: "orphan", status: "completed", turnId: "orphan-turn", createdAt: stamp, updatedAt: stamp, expiresAt: stamp });
    await f.scheduler.advance(f.execution.id);
    expect((await f.scheduler.view(f.execution.id, "chat"))?.steps[0].status).toBe("uncertain");
    expect(f.submit).not.toHaveBeenCalled();
  });

  it.each([undefined, "wrong turn"])("never unlocks completed with invalid turn %s", async turnId => {
    const f = await fixture();
    await f.scheduler.advance(f.execution.id);
    const previous = await f.command(0);
    vi.spyOn(f.store, "findCommandByRequestId").mockImplementation(async requestId =>
      requestId === previous.requestId ? { ...previous, status: "completed", turnId } : null);
    await f.scheduler.advance(f.execution.id);
    expect((await f.scheduler.view(f.execution.id, "chat"))?.steps[0].status).toBe("uncertain");
    expect(f.submit).toHaveBeenCalledTimes(1);
  });

  it.each(["nodeId", "sessionId", "prompt", "requestId", "action", "sendRoute", "skills"])("rejects persisted command %s mismatch", async field => {
    const f = await fixture();
    await f.scheduler.advance(f.execution.id);
    const previous = await f.command(0);
    const mismatch = { ...previous, status: "completed" as const,
      [field]: field === "skills" ? [{ id: "a".repeat(64), digest: "b".repeat(64) }] : "foreign" };
    vi.spyOn(f.store, "findCommandByRequestId").mockResolvedValue(mismatch);
    await f.scheduler.advance(f.execution.id);
    expect((await f.scheduler.view(f.execution.id, "chat"))?.steps[0]).toMatchObject({ status: "uncertain", error: "Execution command identity is inconsistent" });
    expect(f.submit).toHaveBeenCalledTimes(1);
  });

  it("two schedulers and duplicate advances persist one attempt and send once", async () => {
    const f = await fixture();
    const competitor = f.create();
    await Promise.all([f.scheduler.advance(f.execution.id), f.scheduler.advance(f.execution.id), competitor.advance(f.execution.id)]);
    expect(f.submit).toHaveBeenCalledTimes(1);
    expect((await f.store.getExecution(f.execution.id))?.attempts.filter(Boolean)).toHaveLength(1);
    await f.reply(0, "completed");
    await Promise.all([f.scheduler.advance(f.execution.id), competitor.advance(f.execution.id)]);
    expect(f.submit).toHaveBeenCalledTimes(2);
  });

  it.each(["uncertain", "failed"] as const)("blocks another root when a receipt becomes %s during claim", async status => {
    const f = await fixture([[], []]);
    const sendCommand = vi.fn(async (command: { commandId: string }) => {
      await f.store.updateCommandStatus(command.commandId, "accepted", undefined, undefined, "exact-root-turn");
      return { delivered: true };
    });
    const hub = { isNodeConnected: () => true, getNodeSkills: () => [],
      getNodeSession: (_nodeId: string, id: string): Session => ({ id, provider: "codex-app", title: "fixture",
        cwd: "/fixture", status: "idle", loaded: true, capabilities: ["send"], observedAt: new Date().toISOString() }),
      registerCommandResultWaiter: () => ({ wait: async () => null, cancel: () => {} }), sendCommand };
    const commands = new CommandService(f.store, hub, 60);
    const scheduler = f.create(commands, (execution, index) =>
      commands.canDispatchSend(execution.plan.actions[index], execution.plan.actions[index].sendRoute!));
    const original = f.store.compareAndSetExecution.bind(f.store);
    vi.spyOn(f.store, "compareAndSetExecution").mockImplementation(async (next, revision) => {
      if (next.status === "active" && next.attempts[1] && !(await f.store.getExecution(next.id))?.attempts[1]) {
        const first = await f.command(0);
        await f.store.updateCommandStatus(first.commandId, status, undefined, "claim race", first.turnId);
      }
      return original(next, revision);
    });
    await scheduler.advance(f.execution.id);
    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect((await f.command(0)).status).toBe(status);
    expect((await f.command(1)).status).toBe("failed");
    expect((await f.store.getExecution(f.execution.id))?.attempts.every(Boolean)).toBe(true);
    await f.create(commands).advance(f.execution.id);
    expect(sendCommand).toHaveBeenCalledTimes(1);
  });

  it("view is read-only and cross-chat view/cancel cannot inspect or mutate", async () => {
    const f = await fixture();
    const before = await f.store.getExecution(f.execution.id);
    expect(await f.scheduler.view(f.execution.id, "foreign")).toBeNull();
    expect(await f.scheduler.cancel(f.execution.id, "foreign")).toBeNull();
    await f.scheduler.view(f.execution.id, "chat");
    expect(await f.store.getExecution(f.execution.id)).toEqual(before);
    expect(f.submit).not.toHaveBeenCalled();
  });

  it("cancel preserves already sent facts and prevents late completion from sending successors", async () => {
    const f = await fixture();
    await f.scheduler.advance(f.execution.id);
    expect((await f.scheduler.cancel(f.execution.id, "chat"))?.steps.map(step => step.status)).toEqual(["accepted", "cancelled"]);
    await f.reply(0, "completed");
    await f.create().advance(f.execution.id);
    expect((await f.scheduler.view(f.execution.id, "chat"))?.steps.map(step => step.status)).toEqual(["completed", "cancelled"]);
    expect(f.submit).toHaveBeenCalledTimes(1);
  });

  it("cancels all unclaimed steps before any command submission", async () => {
    const f = await fixture();
    expect((await f.scheduler.cancel(f.execution.id, "chat"))?.steps.map(step => step.status)).toEqual(["cancelled", "cancelled"]);
    await f.scheduler.advance(f.execution.id);
    expect(f.submit).not.toHaveBeenCalled();
  });

  it("does not claim that cancellation after the final guard stopped an already admitted send", async () => {
    const f = await fixture();
    const scheduler = f.create({ submit: async (input, waitMs, guard, route) => {
      await guard?.();
      await f.scheduler.cancel(f.execution.id, "chat");
      return f.submit(input, waitMs, undefined, route);
    } });
    await scheduler.advance(f.execution.id);
    expect((await scheduler.view(f.execution.id, "chat"))?.steps.map(step => step.status)).toEqual(["accepted", "cancelled"]);
    expect(f.submit).toHaveBeenCalledTimes(1);
  });

  it("cancel racing after claim blocks the dispatch callback without erasing the attempt", async () => {
    const f = await fixture();
    const entered = deferred(), release = deferred();
    f.beforeGuard(async () => { entered.resolve(); await release.promise; });
    const advancing = f.scheduler.advance(f.execution.id);
    await entered.promise;
    await f.scheduler.cancel(f.execution.id, "chat");
    release.resolve();
    await advancing;
    expect((await f.command(0)).status).toBe("failed");
    expect((await f.store.getExecution(f.execution.id))?.attempts[0]).not.toBeNull();
    expect((await f.scheduler.view(f.execution.id, "chat"))?.steps[1].status).toBe("cancelled");
  });

  it("retries cancellation when an immutable claim wins the first CAS", async () => {
    const f = await fixture();
    const original = f.store.compareAndSetExecution.bind(f.store);
    let raced = false;
    vi.spyOn(f.store, "compareAndSetExecution").mockImplementation(async (next, revision) => {
      if (!raced && next.status === "cancelled") {
        raced = true;
        await original({ ...f.execution, revision: 2, attempts: [{ token: randomUUID(),
          startedAt: f.execution.createdAt, expiresAt: f.execution.createdAt + EXECUTION_CLAIM_MS }, null] }, 1);
      }
      return original(next, revision);
    });
    expect((await f.scheduler.cancel(f.execution.id, "chat"))?.status).toBe("cancelled");
    expect((await f.scheduler.view(f.execution.id, "chat"))?.steps.map(step => step.status)).toEqual(["claimed", "cancelled"]);
    expect(f.submit).not.toHaveBeenCalled();
  });

  it.each(["failed", "revoked", "expired"])("stops unsent successors after %s while retaining sent facts", async reason => {
    const f = await fixture();
    await f.scheduler.advance(f.execution.id);
    if (reason === "failed") await f.reply(0, "failed");
    if (reason === "revoked") f.revoke();
    if (reason === "expired") f.tick(EXECUTION_TTL_MS);
    await f.scheduler.advance(f.execution.id);
    const view = await f.scheduler.view(f.execution.id, "chat");
    expect(view?.status).toBe(reason === "expired" ? "expired" : "failed");
    expect(view?.steps[1].status).toBe(view?.status);
    expect(view?.steps[0].status).toBe(reason === "failed" ? "failed" : "accepted");
    expect(f.submit).toHaveBeenCalledTimes(1);
  });

  it("rechecks allowlist and claim expiration in the actual dispatch callback", async () => {
    for (const revoke of [true, false]) {
      const f = await fixture();
      f.beforeGuard(async () => { if (revoke) f.revoke(); else f.tick(EXECUTION_CLAIM_MS); });
      await f.scheduler.advance(f.execution.id);
      expect((await f.command(0)).status).toBe("failed");
      expect(f.submit).toHaveBeenCalledTimes(1);
      expect((await f.store.getExecution(f.execution.id))?.status).toBe("failed");
    }
  });

  it("does not retry an unknown submit failure before a command was persisted", async () => {
    const f = await fixture();
    const submit = vi.fn(async () => { throw new Error("private prompt fixture error"); });
    const scheduler = f.create({ submit });
    await scheduler.advance(f.execution.id);
    f.tick(EXECUTION_CLAIM_MS);
    await scheduler.advance(f.execution.id);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(f.errors).toHaveBeenCalledTimes(1);
    expect((await scheduler.view(f.execution.id, "chat"))?.steps[0].status).toBe("uncertain");
  });

  it("stop clears its timer, joins pending work, and rejects late dispatch until restart", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const entered = deferred(), release = deferred();
    f.beforeGuard(async () => { entered.resolve(); await release.promise; });
    f.scheduler.start();
    await entered.promise;
    const stopped = vi.fn();
    const stopping = f.scheduler.stop().then(stopped);
    await drain();
    expect(stopped).not.toHaveBeenCalled();
    release.resolve();
    await stopping;
    expect((await f.command(0)).status).toBe("failed");
    expect(vi.getTimerCount()).toBe(0);
    const changes = f.changed.mock.calls.length;
    await f.scheduler.advance(f.execution.id);
    await vi.advanceTimersByTimeAsync(EXECUTION_TICK_MS * 2);
    expect(f.submit).toHaveBeenCalledTimes(1);
    expect(f.changed).toHaveBeenCalledTimes(changes);
  });

  it("can restart after a joined stop and restores work without a second attempt", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    await f.scheduler.stop();
    await f.scheduler.advance(f.execution.id);
    expect(f.submit).not.toHaveBeenCalled();
    f.scheduler.start();
    f.scheduler.start();
    await drain();
    expect(f.submit).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    await f.reply(0, "completed");
    await vi.advanceTimersByTimeAsync(EXECUTION_TICK_MS);
    expect(f.submit).toHaveBeenCalledTimes(2);
    await f.scheduler.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds each background tick to one page and rotates through active records", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    for (let index = 0; index < EXECUTION_PAGE_SIZE; index++) {
      const execution = createExecution(`chat-${index}`, plan([[]]), Date.now());
      await f.store.createExecutionIfAbsent(execution);
    }
    const listing = vi.spyOn(f.store, "listActiveExecutions");
    f.scheduler.start();
    await drain();
    expect(listing).toHaveBeenCalledTimes(1);
    expect(listing.mock.calls[0][0]).toBe(EXECUTION_PAGE_SIZE);
    expect(f.submit).toHaveBeenCalledTimes(EXECUTION_PAGE_SIZE);
    await vi.advanceTimersByTimeAsync(EXECUTION_TICK_MS);
    expect(listing).toHaveBeenCalledTimes(2);
    expect(listing.mock.calls[1][1]).not.toBe("");
    expect(f.submit).toHaveBeenCalledTimes(EXECUTION_PAGE_SIZE + 1);
    await vi.advanceTimersByTimeAsync(EXECUTION_TICK_MS * 2);
    expect(f.submit).toHaveBeenCalledTimes(EXECUTION_PAGE_SIZE + 1);
  });

  it("does not overlap slow ticks and reports background errors without losing its timer", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const release = deferred();
    const original = f.store.listActiveExecutions.bind(f.store);
    const listing = vi.spyOn(f.store, "listActiveExecutions").mockImplementationOnce(async () => { await release.promise; return []; });
    f.scheduler.start();
    await vi.advanceTimersByTimeAsync(EXECUTION_TICK_MS * 3);
    expect(listing).toHaveBeenCalledTimes(1);
    release.resolve(); await drain();
    listing.mockRejectedValueOnce(new Error("private background failure"));
    await vi.advanceTimersByTimeAsync(EXECUTION_TICK_MS);
    expect(f.errors).toHaveBeenCalledTimes(1);
    listing.mockImplementation(original);
    await vi.advanceTimersByTimeAsync(EXECUTION_TICK_MS);
    expect(f.submit).toHaveBeenCalledTimes(1);
  });

  it("reports errors with a static default message, not error bodies or prompts", async () => {
    const f = await fixture();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const scheduler = new ExecutionScheduler(f.store, { submit: async () => { throw new Error("secret-token-private-prompt"); } });
    schedulers.push(scheduler);
    await scheduler.advance(f.execution.id);
    expect(log).toHaveBeenCalledExactlyOnceWith("Execution scheduler operation failed");
  });

  it.each(["route", "skills", "session"])("uses CommandService to revalidate changed %s before wire dispatch", async change => {
    const f = await fixture();
    const session: Session = { id: "session-0", provider: "codex-app", title: "fixture", cwd: "/fixture",
      status: "idle", loaded: true, capabilities: ["send"], observedAt: new Date().toISOString() };
    const sendCommand = vi.fn(async () => ({ delivered: true }));
    const hub = { isNodeConnected: () => true, getNodeSession: () => change === "session" ? null : session,
      getNodeSkills: () => [], registerCommandResultWaiter: () => ({ wait: async () => null, cancel: () => {} }), sendCommand };
    if (change === "route") session.sendAvailability = { route: "desktop-owner", state: "ready",
      observedAt: session.observedAt, validUntil: new Date(Date.now() + 30_000).toISOString() };
    if (change === "skills") {
      const another = createExecution("skill-chat", { ...plan([[]]), actions: [{ ...plan([[]]).actions[0],
        skills: [{ id: "a".repeat(64), digest: "b".repeat(64) }] }] }, f.execution.createdAt);
      await f.store.createExecutionIfAbsent(another);
      const scheduler = f.create(new CommandService(f.store, hub, 60));
      await scheduler.advance(another.id);
      expect((await f.store.getExecution(another.id))?.status).toBe("failed");
    } else {
      const scheduler = f.create(new CommandService(f.store, hub, 60));
      await scheduler.advance(f.execution.id);
      expect((await f.store.getExecution(f.execution.id))?.status).toBe("failed");
    }
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it.each(["route", "skills", "session"])("revalidates %s again after durable command creation", async change => {
    const f = await fixture();
    const action = f.execution.plan.actions[0];
    const session: Session = { id: action.sessionId, provider: "codex-app", title: "fixture", cwd: "/fixture",
      status: "idle", loaded: true, capabilities: ["send"], observedAt: new Date().toISOString() };
    const skill = { id: "a".repeat(64), digest: "b".repeat(64), name: "fixture", description: "fixture", path: "/fixture/SKILL.md" };
    const target = change === "skills" ? createExecution("skill-chat", { ...plan([[]]),
      actions: [{ ...action, skills: [{ id: skill.id, digest: skill.digest }] }] }, f.execution.createdAt) : f.execution;
    if (change === "skills") await f.store.createExecutionIfAbsent(target);
    let changed = false;
    const sendCommand = vi.fn(async () => ({ delivered: true }));
    const hub = { isNodeConnected: () => true,
      getNodeSession: () => changed && change === "session" ? null : session,
      getNodeSkills: () => changed && change === "skills" ? [] : [skill],
      registerCommandResultWaiter: () => ({ wait: async () => null, cancel: () => {} }), sendCommand };
    const original = f.store.createCommandIfAbsent.bind(f.store);
    vi.spyOn(f.store, "createCommandIfAbsent").mockImplementation(async record => {
      const result = await original(record);
      changed = true;
      if (change === "route") session.sendAvailability = { route: "desktop-owner", state: "ready",
        observedAt: session.observedAt, validUntil: new Date(Date.now() + 30_000).toISOString() };
      return result;
    });
    const scheduler = f.create(new CommandService(f.store, hub, 60));
    await scheduler.advance(target.id);
    expect(sendCommand).not.toHaveBeenCalled();
    expect((await f.store.getExecution(target.id))?.status).toBe("failed");
    expect((await f.store.findCommandByRequestId(executionRequestId(target, 0)))?.status).toBe("failed");
  });
});
