import { test } from "node:test";
import assert from "node:assert/strict";
import { ControllerClient, validateControllerUrl, ChatNotAllowedError } from "../../src/controller/client.js";

test("validateControllerUrl enforces HTTPS for remote and allows loopback or explicit ALLOW_INSECURE_CONTROLLER", () => {
  assert.equal(validateControllerUrl("http://127.0.0.1:8790/", false), "http://127.0.0.1:8790");
  assert.equal(validateControllerUrl("http://localhost:8790", false), "http://localhost:8790");
  assert.equal(validateControllerUrl("https://remote.example.com:8790/", false), "https://remote.example.com:8790");

  assert.throws(
    () => validateControllerUrl("http://controller:8790", false),
    /Remote CONTROLLER_URL must use https:///
  );
  assert.equal(validateControllerUrl("http://controller:8790/", true), "http://controller:8790");

  assert.throws(() => validateControllerUrl("http://user:pass@127.0.0.1:8790", true), /userinfo/);
  assert.throws(() => validateControllerUrl("http://127.0.0.1:8790?foo=bar", true), /query/);
  assert.throws(() => validateControllerUrl("http://127.0.0.1:8790#frag", true), /fragment/);
});

test("ControllerClient retries 5xx, throws ChatNotAllowedError on CHAT_NOT_ALLOWED, and rejects 401/403 immediately", async () => {
  let calls = 0;
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
    calls++;
    const auth = (init?.headers as Record<string, string>)?.Authorization;
    assert.equal(auth, "Bearer ctrl-tok");
    if (calls === 1) {
      return new Response(JSON.stringify({ error: "temporary" }), { status: 502 });
    }
    return new Response(JSON.stringify({ text: "handled ok", commandId: "cmd-1" }), { status: 200 });
  };

  const client = new ControllerClient({
    controllerUrl: "http://127.0.0.1:8790",
    controllerToken: "ctrl-tok",
    fetchImpl: fakeFetch as typeof globalThis.fetch,
  });

  const res = await client.forwardMessage({ chatId: "u1", messageId: "m1", text: "hi" });
  assert.equal(res.text, "handled ok");
  assert.equal(res.commandId, "cmd-1");
  assert.equal(calls, 2);

  // 403 with code=CHAT_NOT_ALLOWED throws ChatNotAllowedError
  const poisonClient = new ControllerClient({
    controllerUrl: "http://127.0.0.1:8790",
    controllerToken: "ctrl-tok",
    fetchImpl: (async () => {
      return new Response(JSON.stringify({ error: "chat not allowed", code: "CHAT_NOT_ALLOWED" }), { status: 403 });
    }) as typeof globalThis.fetch,
  });
  await assert.rejects(
    () => poisonClient.forwardMessage({ chatId: "bad-chat", messageId: "m1", text: "hi" }),
    (err: Error) => err instanceof ChatNotAllowedError
  );

  // 401 without code does not retry and fails closed
  let authCalls = 0;
  const authFailClient = new ControllerClient({
    controllerUrl: "http://127.0.0.1:8790",
    controllerToken: "bad-tok",
    fetchImpl: (async () => {
      authCalls++;
      return new Response("unauthorized", { status: 401 });
    }) as typeof globalThis.fetch,
  });
  await assert.rejects(
    () => authFailClient.forwardMessage({ chatId: "u1", messageId: "m1", text: "hi" }),
    /authentication failed/
  );
  assert.equal(authCalls, 1);
});

test("chat authorization uses an authenticated read-only check before any model work", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const client = new ControllerClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: "synthetic",
    fetchImpl: async (input, init) => { calls.push({ url: String(input), init }); return Response.json({ allowed: true }); } });
  await client.assertChatAllowed("chat");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:8790/v1/chats/authorize");
  assert.equal(calls[0].init?.method, "POST");
  assert.equal(calls[0].init?.redirect, "error");
  assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, "Bearer synthetic");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { chatId: "chat" });
});

test("chat authorization rejects denied chats and malformed responses without retrying", async () => {
  for (const [status, body] of [[403, { code: "CHAT_NOT_ALLOWED" }], [200, { allowed: false }],
    [200, { allowed: true, extra: "secret" }], [200, {}], [200, []], [401, {}], [500, {}]] as const) {
    let calls = 0;
    const client = new ControllerClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: "synthetic",
      fetchImpl: async () => { calls++; return Response.json(body, { status }); } });
    await assert.rejects(client.assertChatAllowed("chat"), error => {
      if (status === 403) assert.ok(error instanceof ChatNotAllowedError);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("authorization remains bounded when fetch or response parsing ignores cancellation", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const phase of ["fetch", "body"]) {
    const client = new ControllerClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: "synthetic",
      fetchImpl: async () => phase === "fetch" ? new Promise<Response>(() => {}) :
        new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("{")); } })) });
    const pending = client.assertChatAllowed("chat");
    const rejected = assert.rejects(pending, /authorization timed out/);
    for (let step = 0; step < 8; step++) await Promise.resolve();
    t.mock.timers.tick(client.authorizationBudgetMs);
    await rejected;
  }
});
