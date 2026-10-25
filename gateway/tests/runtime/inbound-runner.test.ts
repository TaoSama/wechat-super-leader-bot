import { test } from "node:test";
import assert from "node:assert/strict";
import { InboundRunner } from "../../src/runtime/inbound-runner.js";
import type { FileInboundInbox } from "../../src/runtime/inbox.js";
import type { InboundWeChatMessage } from "../../src/types.js";

function message(deliveryKey: string): InboundWeChatMessage {
  return { chatId: "chat", text: deliveryKey, messageId: deliveryKey, deliveryKey };
}

function flush(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

test("a failed head message blocks later messages in the same chat until retry succeeds", async () => {
  const items = [message("first"), message("second")];
  const removed: string[] = [];
  const started: string[] = [];
  const errors: unknown[] = [];
  let failFirstAttempt = true;
  const inbox = {
    list: () => items.filter(item => !removed.includes(item.deliveryKey)),
    remove: (deliveryKey: string) => { if (!removed.includes(deliveryKey)) removed.push(deliveryKey); },
  } as unknown as FileInboundInbox;
  const runner = new InboundRunner({
    inbox,
    process: async item => {
      started.push(item.deliveryKey);
      if (item.deliveryKey === "first" && failFirstAttempt) {
        failFirstAttempt = false;
        throw new Error("first attempt failed");
      }
    },
    steer: async () => false,
    covered: () => {},
    onError: error => errors.push(error),
  });

  runner.schedule();
  await flush(); await flush();
  assert.deepEqual(started, ["first"]);
  assert.deepEqual(removed, []);
  assert.equal(errors.length, 1);

  runner.schedule();
  await flush(); await flush();
  assert.deepEqual(started, ["first", "first"]);
  assert.deepEqual(removed, ["first"]);

  runner.schedule();
  await flush(); await flush();
  assert.deepEqual(started, ["first", "first", "second"]);
  assert.deepEqual(removed, ["first", "second"]);
});
