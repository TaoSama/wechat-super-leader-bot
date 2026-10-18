import { test } from "node:test";
import assert from "node:assert/strict";
import { TypingIndicator } from "../../src/wechat/typing.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const PRIVATE_VALUE = "private-ticket-context-and-token";
type Request = {
  endpoint: string;
  payload: Record<string, unknown>;
  token: string;
  timeoutMs: number;
  signal?: AbortSignal;
};

function harness(timeoutMs?: number) {
  const calls: Request[] = [];
  const state = {
    account: { token: "token-a", fingerprint: "account-a" } as { token: string; fingerprint: string } | null,
    now: 1_000,
    context: "context-a" as string | undefined,
    config: { ret: 0, typing_ticket: "ticket-a" } as Record<string, unknown>,
    receipt: {} as Record<string, unknown>,
    hook: undefined as ((call: Request) => Promise<Record<string, unknown>>) | undefined,
  };
  const typing = new TypingIndicator({
    request: async (endpoint, payload, token, budget, signal) => {
      const call = { endpoint, payload, token, timeoutMs: budget, signal };
      calls.push(call);
      return state.hook ? state.hook(call) : endpoint.endsWith("getconfig") ? state.config : state.receipt;
    },
    getAccount: () => state.account,
    getContextToken: () => state.context,
    now: () => state.now,
    timeoutMs,
  });
  return { typing, state, calls };
}

test("typing obtains config then sends a signal with the expected protocol", async () => {
  const f = harness();
  assert.equal(await f.typing.send("chat-a"), true);
  assert.deepEqual(f.calls.map(call => [call.endpoint, call.payload, call.token]), [
    ["ilink/bot/getconfig", {
      ilink_user_id: "chat-a", context_token: "context-a", base_info: { channel_version: "0.3.0" },
    }, "token-a"],
    ["ilink/bot/sendtyping", {
      ilink_user_id: "chat-a", typing_ticket: "ticket-a", status: 1, base_info: { channel_version: "0.3.0" },
    }, "token-a"],
  ]);
  assert.ok(f.calls.every(call => call.timeoutMs > 0 && call.timeoutMs <= 1_000));
  assert.ok(f.calls.every(call => call.signal instanceof AbortSignal));
});

test("tickets are reused for start and stop and isolated by user", async () => {
  const f = harness();
  assert.equal(await f.typing.send("chat-a"), true);
  assert.equal(await f.typing.send("chat-a", 2), true);
  assert.equal(await f.typing.send("chat-b", 2), false);
  assert.equal(f.calls.length, 3);
  f.state.config = { ret: 0, typing_ticket: "ticket-b" };
  assert.equal(await f.typing.send("chat-b"), true);
  assert.equal(await f.typing.send("chat-a"), true);
  assert.equal(f.calls.at(-1)?.payload.typing_ticket, "ticket-a");
  assert.equal(f.calls.filter(call => call.endpoint.endsWith("getconfig")).length, 2);
});

for (const endpoint of ["getconfig", "sendtyping"]) {
  test(`overlapping typing during ${endpoint} is coalesced and later signals can refresh`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const f = harness();
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const began = new Promise<void>(resolve => { started = resolve; });
    f.state.hook = async call => {
      if (call.endpoint.endsWith(endpoint)) { started(); await gate; }
      return call.endpoint.endsWith("getconfig") ? f.state.config : f.state.receipt;
    };
    const original = f.typing.send("chat");
    try {
      await began;
      const count = f.calls.length;
      assert.equal(await f.typing.send("chat"), false);
      assert.equal(f.calls.length, count, "a duplicate cannot start another config or signal request");
    } finally { release(); await original; }
    assert.equal(await original, true);
    assert.equal(f.calls.filter(call => call.endpoint.endsWith("getconfig")).length, 1);
    assert.equal(f.calls.filter(call => call.endpoint.endsWith("sendtyping")).length, 1);
    f.state.hook = undefined;
    assert.equal(await f.typing.send("chat"), true);
    assert.equal(f.calls.filter(call => call.endpoint.endsWith("getconfig")).length, 1);
    f.state.now += DAY_MS;
    f.state.config = { ret: 0, typing_ticket: "refreshed-ticket" };
    assert.equal(await f.typing.send("chat"), true);
    assert.equal(f.calls.filter(call => call.endpoint.endsWith("getconfig")).length, 2);
    assert.equal(f.calls.at(-1)?.payload.typing_ticket, "refreshed-ticket");
  });

  test(`changing accounts bypasses an old in-flight ${endpoint} and preserves the new ticket`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const f = harness();
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const began = new Promise<void>(resolve => { started = resolve; });
    f.state.hook = async call => {
      if (call.token === "token-a" && call.endpoint.endsWith(endpoint)) {
        started(); await gate; return { ret: -1 };
      }
      return call.endpoint.endsWith("getconfig") ? { ret: 0, typing_ticket: `ticket:${call.token}` } : { ret: 0 };
    };
    const old = f.typing.send("chat");
    try {
      await began;
      f.state.account = { token: "token-b", fingerprint: "account-b" };
      assert.equal(await f.typing.send("chat"), true, "the old account cannot suppress a new account signal");
      assert.equal(f.calls.at(-1)?.token, "token-b");
      assert.equal(f.calls.at(-1)?.payload.typing_ticket, "ticket:token-b");
    } finally { release(); await old; }
    assert.equal(await old, false);
    const before = f.calls.length;
    assert.equal(await f.typing.send("chat"), true, "late old rejection cannot back off the new account");
    assert.equal(f.calls.length, before + 1, "the new account reuses its unaffected ticket");
    assert.equal(f.calls.at(-1)?.payload.typing_ticket, "ticket:token-b");
    assert.equal(f.calls.at(-1)?.token, "token-b");
  });
}

test("ticket expires at 24 hours without refreshing its lifetime on reuse", async () => {
  const f = harness();
  await f.typing.send("chat");
  f.state.now += DAY_MS - 1;
  assert.equal(await f.typing.send("chat"), true);
  f.state.now++;
  assert.equal(await f.typing.send("chat", 2), false);
  f.state.config = { ret: 0, typing_ticket: "new-ticket" };
  assert.equal(await f.typing.send("chat"), true);
  assert.equal(f.calls.at(-1)?.payload.typing_ticket, "new-ticket");
  assert.equal(f.calls.filter(call => call.endpoint.endsWith("getconfig")).length, 2);
});

test("changing either fingerprint or token clears all cached users", async () => {
  const f = harness();
  await f.typing.send("chat");
  for (const account of [{ token: "token-a", fingerprint: "account-b" },
    { token: "token-b", fingerprint: "account-b" }]) {
    f.state.account = account;
    assert.equal(await f.typing.send("chat", 2), false);
    assert.equal(await f.typing.send("chat"), true);
  }
  assert.equal(f.calls.filter(call => call.endpoint.endsWith("getconfig")).length, 3);
  f.state.account = null;
  assert.equal(await f.typing.send("chat"), false);
  f.state.account = { token: "token-a", fingerprint: "account-a" };
  assert.equal(await f.typing.send("chat", 2), false);
});

test("account changes during config cannot publish an old account ticket", async () => {
  const f = harness();
  f.state.hook = async () => {
    f.state.account = { token: "new-token", fingerprint: "new-account" };
    return { ret: 0, typing_ticket: PRIVATE_VALUE };
  };
  assert.equal(await f.typing.send("chat"), false);
  assert.equal(f.calls.length, 1);
  assert.equal(await f.typing.send("chat", 2), false);
});

for (const config of [{}, { ret: 1, typing_ticket: PRIVATE_VALUE }, { ret: "0", typing_ticket: PRIVATE_VALUE },
  { ret: 0, errcode: 1, typing_ticket: PRIVATE_VALUE }, { ret: 0 }, { ret: 0, typing_ticket: "  " },
  { ret: 0, typing_ticket: 123 }]) {
  test(`invalid config ${Object.keys(config).join(",")} is not cached and backs off`, async () => {
    const f = harness();
    f.state.config = config;
    assert.equal(await f.typing.send("chat"), false);
    assert.equal(await f.typing.send("chat"), false);
    assert.equal(f.calls.length, 1);
    f.state.now += 2_000;
    f.state.config = { ret: 0, typing_ticket: "recovered" };
    assert.equal(await f.typing.send("chat"), true);
    assert.equal(f.calls.length, 3);
  });
}

for (const receipt of [{ ret: -1 }, { errcode: -14 }, { ret: 0, errcode: 1 },
  { ret: "0" }, { errcode: null }]) {
  test(`rejected send receipt ${JSON.stringify(receipt)} invalidates its ticket`, async () => {
    const f = harness();
    f.state.receipt = receipt;
    assert.equal(await f.typing.send("chat"), false);
    f.state.now += 1_999;
    assert.equal(await f.typing.send("chat"), false);
    assert.equal(f.calls.length, 2);
    f.state.now++;
    assert.equal(await f.typing.send("chat", 2), false);
    f.state.receipt = { ret: 0, errcode: 0 };
    assert.equal(await f.typing.send("chat"), true);
    assert.equal(f.calls.length, 4);
  });
}

test("transport exceptions and sensitive receipts return false without diagnostics", async t => {
  const diagnostics: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { diagnostics.push(args); });
  t.mock.method(console, "warn", (...args: unknown[]) => { diagnostics.push(args); });
  const f = harness();
  f.state.hook = async () => { throw new Error(PRIVATE_VALUE); };
  assert.equal(await f.typing.send("chat"), false);
  f.state.now += 2_000;
  f.state.hook = undefined;
  f.state.receipt = { ret: 1, errmsg: PRIVATE_VALUE };
  assert.equal(await f.typing.send("chat"), false);
  assert.deepEqual(diagnostics, []);
});

test("missing account or context performs no requests", async () => {
  const f = harness();
  f.state.account = null;
  assert.equal(await f.typing.send("chat"), false);
  f.state.account = { token: "token", fingerprint: "account" };
  f.state.context = undefined;
  assert.equal(await f.typing.send("chat"), false);
  assert.equal(f.calls.length, 0);
});

for (const blockedEndpoint of ["getconfig", "sendtyping"]) {
  test(`overall timeout bounds an abort-ignoring ${blockedEndpoint} and discards late completion`, async () => {
    const f = harness(20);
    let release: (value: Record<string, unknown>) => void = () => { throw new Error("Request not blocked"); };
    f.state.hook = async call => call.endpoint.endsWith(blockedEndpoint)
      ? new Promise(resolve => { release = resolve; }) : { ret: 0, typing_ticket: "ticket" };
    const started = performance.now();
    assert.equal(await f.typing.send("chat"), false);
    assert.ok(performance.now() - started < 500);
    assert.equal(f.calls.at(-1)?.signal?.aborted, true);
    const count = f.calls.length;
    release({ ret: 0, typing_ticket: PRIVATE_VALUE });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.calls.length, count);
    assert.equal(await f.typing.send("chat"), false);
    f.state.now += 2_000;
    assert.equal(await f.typing.send("chat", 2), false);
    f.state.hook = undefined;
    assert.equal(await f.typing.send("chat"), true);
    assert.equal(f.calls.filter(call => call.endpoint.endsWith("getconfig")).length, 2);
  });
}

test("timeout covers the combined config and send budget", async () => {
  const f = harness(30);
  f.state.hook = async call => {
    if (call.endpoint.endsWith("getconfig")) {
      await new Promise(resolve => setTimeout(resolve, 15));
      return { ret: 0, typing_ticket: "ticket" };
    }
    assert.ok(call.timeoutMs <= 20);
    return new Promise(() => {});
  };
  const started = performance.now();
  assert.equal(await f.typing.send("chat"), false);
  assert.ok(performance.now() - started < 500);
});

test("a late rejection after timeout cannot invalidate a recovered ticket", async () => {
  const f = harness(20);
  let rejectRequest: (reason: Error) => void = () => { throw new Error("Request not blocked"); };
  f.state.hook = async () => new Promise((_resolve, reject) => { rejectRequest = reject; });
  assert.equal(await f.typing.send("chat"), false);
  f.state.now += 2_000;
  f.state.hook = undefined;
  assert.equal(await f.typing.send("chat"), true);
  rejectRequest(new Error(PRIVATE_VALUE));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(await f.typing.send("chat", 2), true);
  assert.equal(f.calls.filter(call => call.endpoint.endsWith("getconfig")).length, 2);
});

test("custom budgets cannot exceed 1000 ms", async () => {
  const f = harness(5_000);
  assert.equal(await f.typing.send("chat"), true);
  assert.ok(f.calls.every(call => call.timeoutMs <= 1_000));
});

test("cache evicts the least recently used user beyond 1000 entries", async () => {
  const f = harness();
  for (let index = 0; index < 1_000; index++) assert.equal(await f.typing.send(`chat-${index}`), true);
  assert.equal(await f.typing.send("chat-0", 2), true);
  assert.equal(await f.typing.send("chat-new"), true);
  const before = f.calls.length;
  assert.equal(await f.typing.send("chat-1", 2), false);
  assert.equal(f.calls.length, before);
  assert.equal(await f.typing.send("chat-0", 2), true);
});
