import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { test, type TestContext } from "node:test";
import { ControllerClient } from "../../src/controller/client.js";

const REQUEST_TIMEOUT_MS = 2_000;
const RESPONSE_CLOSE_TIMEOUT_MS = 1_000;
const REQUEST = { chatId: "synthetic-chat", messageId: "synthetic-message", text: "query" };

async function streamingErrors(t: TestContext, status: number, options: {
  recover?: boolean;
  contentType?: string;
} = {}) {
  let requests = 0;
  const openResponses = new Set<ServerResponse>();
  const closedResponses: Promise<void>[] = [];
  const server = createServer((request, response) => {
    requests++;
    request.resume();
    if (options.recover && requests > 1) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ text: "recovered" }));
      return;
    }
    openResponses.add(response);
    closedResponses.push(new Promise<void>(resolve => {
      response.once("close", () => { openResponses.delete(response); resolve(); });
    }));
    response.writeHead(status, { "content-type": options.contentType ?? "application/json" });
    response.write("{");
  });
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new ControllerClient({
    controllerUrl: `http://127.0.0.1:${address.port}`,
    controllerToken: "synthetic-token",
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
  return {
    client,
    async assertReleased(expectedRequests: number, expectedStreams = expectedRequests) {
      assert.equal(requests, expectedRequests);
      assert.equal(closedResponses.length, expectedStreams);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all(closedResponses),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("Controller left an error response open")), RESPONSE_CLOSE_TIMEOUT_MS);
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      assert.equal(openResponses.size, 0);
      t.diagnostic(JSON.stringify({ status, requests, streamedResponses: closedResponses.length, openResponses: openResponses.size }));
    },
  };
}

const failureCases: {
  name: string;
  status: number;
  requests: number;
  error: RegExp;
  progress?: boolean;
  contentType?: string;
}[] = [
  { name: "503 retries", status: 503, requests: 3, error: /returned HTTP 503/ },
  { name: "401 authentication failure", status: 401, requests: 1, error: /authentication failed \(HTTP 401\)/ },
  { name: "400 client failure", status: 400, requests: 1, error: /returned HTTP 400/ },
  { name: "403 stalled authentication body", status: 403, requests: 1, error: /authentication\/authorization failed \(HTTP 403\)/ },
  { name: "503 with progress", status: 503, requests: 1, error: /returned HTTP 503/, progress: true },
  { name: "unexpected progress stream", status: 200, requests: 1, error: /invalid response schema \(unexpected stream\)/,
    contentType: "application/x-ndjson" },
];

for (const scenario of failureCases) {
  test(`real HTTP releases unfinished response bodies after ${scenario.name}`, { timeout: 10_000 }, async t => {
    const fixture = await streamingErrors(t, scenario.status, { contentType: scenario.contentType });
    await assert.rejects(fixture.client.forwardMessage(REQUEST, scenario.progress ? {
      progressRemaining: 0,
      onProgress: async () => assert.fail("Error responses must not emit progress"),
    } : undefined), scenario.error);
    await fixture.assertReleased(scenario.requests);
  });
}

test("real HTTP releases a failed attempt when its retry succeeds", { timeout: 10_000 }, async t => {
  const fixture = await streamingErrors(t, 503, { recover: true });
  assert.equal((await fixture.client.forwardMessage(REQUEST)).text, "recovered");
  await fixture.assertReleased(2, 1);
});
