import { test } from "node:test";
import assert from "node:assert/strict";
import nodeFs from "node:fs";
import { ILinkClient } from "../../src/wechat/client.js";
import { ILinkSendReceiptError, parseILinkJson, validateSendReceipt } from "../../src/wechat/send-receipt.js";
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
  [{ message_id: " \t" }, "ILinkSendInvalidMessageId"],
  [{ message_id: -1 }, "ILinkSendInvalidMessageId"],
  [{ message_id: 1.5 }, "ILinkSendInvalidMessageId"],
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
  assert.equal([...f.records.values()][0].status, "uncertain");
  assert.equal(JSON.parse(diagnostics[0]).errorType, errorType);
  assert.ok(!diagnostics[0].includes(PRIVATE_VALUE));
  await f.gateway.deliverNotificationsOnce();
  assert.equal(f.sends.length, 2, "one ordinary send and one notification, never a replay");
});

for (const response of [{}, { errmsg: "" }, { errmsg: " \t" },
  { message_id: "123" }, { message_id: "18446744073709551615" },
  { message_id: 0 }, { message_id: 123 }, { message_id: Number.MAX_SAFE_INTEGER },
  { ret: 0 }, { errcode: 0 }, { ret: 0, errcode: 0, errmsg: "ok", message_id: "123" }]) {
  test(`ordinary and notification replies use the same success contract: ${JSON.stringify(response)}`, async t => {
    const f = harness(t); f.hooks.send = () => response;
    await f.ilink.sendSingleText("chat", "ordinary");
    assert.equal((await f.gateway.deliverNotificationsOnce()).accepted, 1);
    await f.gateway.deliverNotificationsOnce();
    assert.equal(f.sends.length, 2);
  });
}

test("valid JSON objects may omit a return code and 64-bit string IDs remain lossless", () => {
  assert.doesNotThrow(() => validateSendReceipt({}));
  assert.doesNotThrow(() => validateSendReceipt({ errmsg: "" }));
  const response = { message_id: "18446744073709551615" };
  validateSendReceipt(response);
  assert.equal(response.message_id, "18446744073709551615");
});

test("numeric message IDs require a nonnegative safe integer even with an explicit success code", () => {
  for (const message_id of [0, 123, Number.MAX_SAFE_INTEGER]) {
    assert.doesNotThrow(() => validateSendReceipt({ message_id }));
  }
  for (const message_id of [Number.MAX_SAFE_INTEGER + 1, 1.5, -1, NaN, Infinity, -Infinity]) {
    for (const response of [{ message_id }, { ret: 0, message_id }]) {
      assert.throws(() => validateSendReceipt(response), error => {
        assert.ok(error instanceof ILinkSendReceiptError);
        assert.equal(error.reason, "InvalidMessageId");
        return true;
      });
    }
  }
});

test("wire parser preserves 64-bit identifiers and never rewrites numeric-looking message bodies", () => {
  const raw = '{"message_id":18446744073709551615,"msg_id":9223372036854775807,"svr_id":9007199254740993,"text":"message_id:18446744073709551615 🚀","count":123}';
  const parsed = parseILinkJson(raw);
  assert.deepEqual(parsed, {
    message_id: "18446744073709551615", msg_id: "9223372036854775807", svr_id: "9007199254740993",
    text: "message_id:18446744073709551615 🚀", count: 123,
  });
  assert.ok(parsed && typeof parsed === "object" && "message_id" in parsed);
  validateSendReceipt({ message_id: parsed.message_id });
  assert.deepEqual(parseILinkJson('{"message\\u005fid":18446744073709551615}'), { message_id: "18446744073709551615" });
  assert.deepEqual(parseILinkJson('{"message_id":"18446744073709551615","text":"\\\"message_id\\\":18446744073709551615"}'), {
    message_id: "18446744073709551615", text: '"message_id":18446744073709551615',
  });
});

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
