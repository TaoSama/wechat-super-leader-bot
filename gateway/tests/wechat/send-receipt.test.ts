import { test } from "node:test";
import assert from "node:assert/strict";
import nodeFs from "node:fs";
import { ILinkClient } from "../../src/wechat/client.js";
import { sanitizeErrorType } from "../../src/runtime/health.js";
import { harness, claimed, notification } from "../fixtures/notification-fixtures.js";

const PRIVATE_VALUE = "private-token-context-chat-body";
const invalidReceipts: [unknown, string][] = [
  [{ ret: null }, "ILinkSendInvalidRet"],
  [{ ret: "0" }, "ILinkSendInvalidRet"],
  [{ ret: false }, "ILinkSendInvalidRet"],
  [{ ret: {} }, "ILinkSendInvalidRet"],
  [{ ret: PRIVATE_VALUE }, "ILinkSendInvalidRet"],
  [{ ret: 1.5 }, "ILinkSendInvalidRet"],
  [{ ret: -14, errmsg: PRIVATE_VALUE }, "ILinkSendRejectedRet"],
  [{ errcode: 1 }, "ILinkSendRejectedErrcode"],
  [{ ret: 0, errcode: null }, "ILinkSendInvalidErrcode"],
  [{ ret: 0, errcode: "0" }, "ILinkSendInvalidErrcode"],
  [{ ret: 0, errcode: 1 }, "ILinkSendRejectedErrcode"],
  [{ ret: 1, errcode: 0 }, "ILinkSendRejectedRet"],
  [{ base_resp: { ret: 0 } }, "ILinkSendUnsupportedShape"],
  [{ ret: 0, base_resp: { ret: -14 } }, "ILinkSendUnsupportedShape"],
  [{ error: PRIVATE_VALUE }, "ILinkSendUnsupportedShape"],
  [{ [PRIVATE_VALUE]: 0 }, "ILinkSendUnsupportedShape"],
  [{ message_id: {} }, "ILinkSendInvalidMessageId"],
  [{ message_id: "" }, "ILinkSendInvalidMessageId"],
  [{ message_id: -1 }, "ILinkSendInvalidMessageId"],
  [{ errmsg: null }, "ILinkSendInvalidErrorMessage"],
  [{ errmsg: PRIVATE_VALUE }, "ILinkSendUnconfirmedErrorMessage"],
  [[], "ILinkInvalidResponse"],
  [null, "ILinkInvalidResponse"],
  [PRIVATE_VALUE, "ILinkInvalidResponse"],
];

for (const [response, errorType] of invalidReceipts) test(`send receipt rejects ${JSON.stringify(response)} without exposing response`, async t => {
  const f = harness(t); f.hooks.send = () => response;
  await assert.rejects(f.ilink.sendSingleText("chat", "ordinary"), (error: Error) => {
    assert.equal(sanitizeErrorType(error), errorType);
    assert.ok(!error.message.includes(PRIVATE_VALUE));
    return true;
  });
  const diagnostics: string[] = [];
  t.mock.method(nodeFs, "writeSync", (_fd: number, chunk: string) => {
    diagnostics.push(chunk); return Buffer.byteLength(chunk);
  });
  assert.equal((await f.gateway.deliverNotificationsOnce()).uncertain, 1);
  assert.equal(JSON.parse(diagnostics[0]).errorType, errorType);
  assert.ok(!diagnostics[0].includes(PRIVATE_VALUE));
  await f.gateway.deliverNotificationsOnce();
  assert.equal(f.sends.length, 2, "one ordinary send and one notification, never a replay");
});

for (const response of [{}, { message_id: "123" }, { message_id: 123 }, { errmsg: "" },
  { ret: 0 }, { errcode: 0 }, { ret: 0, errcode: 0, errmsg: "ok", message_id: "123" }]) {
  test(`ordinary and notification replies use the same success contract: ${JSON.stringify(response)}`, async t => {
    const f = harness(t); f.hooks.send = () => response;
    await f.ilink.sendSingleText("chat", "ordinary");
    assert.equal((await f.gateway.deliverNotificationsOnce()).accepted, 1);
    await f.gateway.deliverNotificationsOnce();
    assert.equal(f.sends.length, 2);
  });
}

test("pre-existing uncertain notification is unchanged when the provider now returns an accepted shape", async t => {
  const item = { ...claimed(notification()), status: "uncertain" as const };
  const f = harness(t, { items: [item] }); f.hooks.send = () => ({});
  await f.gateway.deliverNotificationsOnce();
  assert.deepEqual([...f.records.values()], [item]);
  assert.equal(f.sends.length, 0);
  assert.equal(f.requests.filter(request => request.url.endsWith("claim") || request.url.endsWith("receipt")).length, 0);
});

for (const status of [401, 403, 500]) test(`HTTP ${status} is attributed to the service that returned it`, async t => {
  const f = harness(t);
  const client = new ILinkClient({ stateManager: f.state, fetchImpl: async () => new Response(PRIVATE_VALUE, { status }) });
  await assert.rejects(client.sendSingleText("chat", "ordinary"), error => {
    assert.equal(sanitizeErrorType(error), `ILinkHttp${status}`); return true;
  });
  assert.equal(sanitizeErrorType(new Error(`Controller authentication/authorization failed (HTTP ${status})`)),
    `${status === 500 ? "ControllerHttp" : "ControllerAuth"}${status}`);
  assert.equal(sanitizeErrorType(new Error(`Unrelated HTTP ${status}`)), `Http${status}`);
});
