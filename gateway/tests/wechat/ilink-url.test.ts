import { test } from "node:test";
import assert from "node:assert/strict";
import { ILinkClient, DEFAULT_ILINK_BASE_URL } from "../../src/wechat/client.js";
import type { StateManager } from "../../src/runtime/state.js";

function state(baseUrl?: string): StateManager {
  return { account: { token: "fixture-token", accountId: "fixture", baseUrl }, syncBuf: "" } as StateManager;
}

test("iLink rejects unsafe account and explicit URLs before any credential-bearing request", () => {
  const urls = ["http://remote.example", "http://127.0.0.1", "ftp://remote.example", "not-a-url",
    "https://user:private-value@example.com", "https://example.com?token=private-value",
    "https://example.com#private-value", "https://exam\nple.com", "https://example.com\\path"];
  let requests = 0;
  const fetchImpl = (async () => { requests++; throw new Error("unexpected network call"); }) as typeof fetch;
  for (const url of urls) {
    for (const explicit of [false, true]) {
      assert.throws(() => new ILinkClient({ stateManager: state(explicit ? undefined : url),
        configuredBaseUrl: explicit ? url : undefined, fetchImpl }), error => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes("private-value"));
        assert.match(error.message, /iLink base URL/);
        return true;
      });
    }
  }
  assert.equal(requests, 0);
});

test("iLink preserves HTTPS regional/path endpoints and configured override, and requests redirect rejection", async () => {
  assert.equal(new ILinkClient({ stateManager: state() }).baseUrl, DEFAULT_ILINK_BASE_URL);
  assert.equal(new ILinkClient({ stateManager: state("https://region.example/") }).baseUrl, "https://region.example");
  let calls = 0;
  const client = new ILinkClient({ stateManager: state("https://old.example"),
    configuredBaseUrl: "https://region.example/proxy/",
    fetchImpl: async (input, init) => {
      calls++;
      assert.equal(input, "https://region.example/proxy/ilink/bot/getupdates");
      assert.equal(init?.redirect, "error");
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer fixture-token");
      return new Response(JSON.stringify({ ret: 0, msgs: [], get_updates_buf: "next" }));
    },
  });
  assert.equal((await client.pollBatch()).nextSyncBuf, "next");
  assert.equal(calls, 1);
});
