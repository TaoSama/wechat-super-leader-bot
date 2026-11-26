import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ILinkClient } from "../../src/wechat/client.js";
import { StateManager } from "../../src/runtime/state.js";
import { sanitizeErrorType } from "../../src/runtime/health.js";
import { createMessageTrace, runWithTrace } from "../../src/runtime/telemetry.js";

for (const response of [
  { ret: -14 }, { ret: 0, errcode: -14 }, { ret: -2, errcode: 123 },
  { ret: "private-token", errcode: { private: "private-body" } },
  { ret: 0.5, errcode: Number.MAX_SAFE_INTEGER + 1 },
]) {
  test("poll rejection records only safe numeric codes without mutating its checkpoint", async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-poll-diagnostics-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const account = path.join(directory, "account.json"), checkpoint = path.join(directory, "state.json");
    fs.writeFileSync(account, JSON.stringify({ token: "private-token", accountId: "private-account" }));
    const state = new StateManager(account, checkpoint);
    state.markBaselineEstablished();
    state.commitCursor("private-cursor");
    const before = fs.readFileSync(checkpoint, "utf8");
    const events: Record<string, unknown>[] = [];
    const trace = createMessageTrace("poll", "fixture", event => events.push(event));
    let requests = 0;
    const client = new ILinkClient({ stateManager: state, fetchImpl: async () => {
      requests++;
      return Response.json({ ...response, errmsg: "private-body", get_updates_buf: "discarded-cursor" });
    } });
    await runWithTrace(trace, () => assert.rejects(client.pollBatch(), error => {
      assert.equal(sanitizeErrorType(error), "ILinkGetUpdatesError");
      assert.ok(!String(error).includes("private-"));
      return true;
    }));
    const rejected = events.filter(event => event.stage === "wechat.poll.rejected");
    assert.equal(rejected.length, 1);
    for (const field of ["ret", "errcode"] as const) {
      const value = response[field];
      assert.equal(rejected[0][field], typeof value === "number" && Number.isSafeInteger(value) ? value : null);
    }
    assert.equal(rejected[0].traceId, trace.traceId);
    assert.equal(requests, 1, "no additional getupdates retry");
    assert.equal(fs.readFileSync(checkpoint, "utf8"), before);
    assert.ok(!JSON.stringify(events).includes("private-"));
  });
}
