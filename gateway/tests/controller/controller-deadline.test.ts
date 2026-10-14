import { test } from "node:test";
import assert from "node:assert/strict";
import { ControllerClient, DEFAULT_CONTROLLER_TIMEOUT_MS } from "../../src/controller/client.js";

test("Gateway waits beyond 30s for the complete Leader query and bounds it at 105s", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal: AbortSignal | undefined;
  let finish!: (response: Response) => void;
  const client = new ControllerClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: "test", maxRetries: 0,
    fetchImpl: async (_url, init) => {
      signal = init?.signal as AbortSignal;
      return new Promise<Response>((resolve, reject) => {
        finish = resolve;
        signal?.addEventListener("abort", () => reject(new Error("deadline reached")), { once: true });
      });
    } });
  const pending = client.forwardMessage({ chatId: "test-chat", messageId: "same-message", text: "query" });
  t.mock.timers.tick(90001);
  assert.equal(signal?.aborted, false);
  finish(new Response(JSON.stringify({ text: "active query completed" })));
  assert.equal((await pending).text, "active query completed");
  const aborted = client.forwardMessage({ chatId: "test-chat", messageId: "next-message", text: "query" });
  const rejected = assert.rejects(aborted, /deadline reached/);
  t.mock.timers.tick(DEFAULT_CONTROLLER_TIMEOUT_MS);
  await rejected;
});

test("a lost HTTP receipt retries the identical message ID and payload at most twice", async () => {
  const bodies: string[] = [];
  const client = new ControllerClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: "test",
    fetchImpl: async (_url, init) => {
      bodies.push(init?.body as string);
      if (bodies.length === 1) throw new Error("lost receipt");
      return new Response(JSON.stringify({ text: "stored receipt", commandId: "same-command" }));
    } });
  const reply = await client.forwardMessage({ chatId: "chat", messageId: "same-message", text: "确认执行" });
  assert.equal(reply.commandId, "same-command");
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
});

test("all three timed out Controller attempts stay within the advertised 315s budget", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const client = new ControllerClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: "test",
    fetchImpl: async (_url, init) => {
      calls++;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("request timed out")), { once: true });
      });
    } });
  assert.equal(client.requestBudgetMs, 315000);
  const pending = client.forwardMessage({ chatId: "chat", messageId: "same-id", text: "query" });
  const rejected = assert.rejects(pending, /timed out/);
  for (let attempt = 0; attempt < 3; attempt++) {
    t.mock.timers.tick(DEFAULT_CONTROLLER_TIMEOUT_MS);
    for (let step = 0; step < 4; step++) await Promise.resolve();
  }
  await rejected;
  assert.equal(calls, 3);
});
