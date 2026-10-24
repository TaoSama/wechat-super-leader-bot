import { describe, it, expect, vi } from "vitest";
import { HttpLeaderModel } from "../../../src/leader/model/client.js";
import { type ModelMessage, type ModelTool } from "../../../src/leader/model/contracts.js";

const config = { baseUrl: "https://model.example/v1", apiKey: "private-key", model: "test-model", retryDelayMs: 0 };
const messages = [{ role: "user" as const, content: "查询" }];
const body = (output: unknown[] = [], status = "completed", extra: Record<string, unknown> = {}) =>
  JSON.stringify({ status, output, ...extra });
const textOutput = (text: string) => ({
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text }],
});
const callOutput = (callId = "tool-1", name = "list_nodes", args = "{}") => ({
  type: "function_call",
  call_id: callId,
  name,
  arguments: args,
  status: "completed",
});
const reasoningOutput = (encrypted = "enc_secret", summary: unknown[] = []) => ({
  type: "reasoning",
  summary,
  encrypted_content: encrypted,
});
const call = { id: "tool-1", type: "function", function: { name: "list_nodes", arguments: "{}" } };
const sampleTool: ModelTool = {
  type: "function",
  function: {
    name: "list_nodes",
    description: "读取节点",
    parameters: { type: "object", properties: {} },
  },
};
const ok = () => new Response(body([textOutput("测试回答")]));

describe("HTTP Leader model", () => {
  it("serializes conversation/tools with authentication and rejects redirects", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      new Response(body([callOutput("tool-1", "list_nodes", "{}")]))
    );
    const model = new HttpLeaderModel({ ...config, fetchImpl: fetcher });
    const reply = await model.complete(messages, [sampleTool]);
    expect(reply.toolCalls).toEqual([call]);
    const [url, request] = fetcher.mock.calls[0];
    expect(url).toBe("https://model.example/v1/responses");
    expect(request?.redirect).toBe("error");
    expect(request?.headers).toMatchObject({ Authorization: "Bearer private-key" });
    const reqBody = JSON.parse(request?.body as string);
    expect(reqBody).toMatchObject({
      model: "test-model",
      store: false,
      include: ["reasoning.encrypted_content"],
      input: [{ role: "user", content: "查询" }],
      tools: [
        {
          type: "function",
          name: "list_nodes",
          description: "读取节点",
          parameters: { type: "object", properties: {} },
          strict: false,
        },
      ],
    });
  });

  it("preserves native reasoning and function_call in responseOutput and roundtrips tool outputs", async () => {
    const reasoningItem = reasoningOutput("enc_blob_123");
    const fnItem = callOutput("tool-1", "list_nodes", "{}");
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(body([reasoningItem, fnItem])))
      .mockResolvedValueOnce(new Response(body([textOutput("节点已查明")])));
    const model = new HttpLeaderModel({ ...config, fetchImpl: fetcher });

    const step1 = await model.complete(messages, [sampleTool]);
    expect(step1.toolCalls).toEqual([call]);
    expect(step1.responseOutput).toEqual([reasoningItem, fnItem]);

    const nextMessages: ModelMessage[] = [
      ...messages,
      { role: "assistant", content: null, responseOutput: step1.responseOutput },
      { role: "tool", tool_call_id: "tool-1", content: '{"nodes":["macair"]}' },
    ];

    const step2 = await model.complete(nextMessages, [sampleTool]);
    expect(step2.content).toBe("节点已查明");
    expect(fetcher).toHaveBeenCalledTimes(2);

    const secondReqBody = JSON.parse(fetcher.mock.calls[1][1]?.body as string);
    expect(secondReqBody.input).toEqual([
      { role: "user", content: "查询" },
      reasoningItem,
      fnItem,
      { type: "function_call_output", call_id: "tool-1", output: '{"nodes":["macair"]}' },
    ]);
  });

  it("retries transient HTTP statuses at most twice without exposing response bodies", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("secret-error", { status: 503 }))
      .mockResolvedValueOnce(new Response("secret-error", { status: 429 })).mockImplementationOnce(async () => ok());
    expect((await new HttpLeaderModel({ ...config, fetchImpl: fetcher }).complete(messages, [])).content).toBe("测试回答");
    expect(fetcher).toHaveBeenCalledTimes(3);
    const failing = vi.fn<typeof fetch>(async () => new Response("secret-error", { status: 502 }));
    await expect(new HttpLeaderModel({ ...config, fetchImpl: failing }).complete(messages, [])).rejects.toThrow("HTTP status 502");
    expect(failing).toHaveBeenCalledTimes(3);
  });

  it("does not retry authorization or unrecognized transport failures and sanitizes errors", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("private-key", { status: 401 }));
    await expect(new HttpLeaderModel({ ...config, fetchImpl: fetcher }).complete(messages, [])).rejects.toThrow("HTTP status 401");
    expect(fetcher).toHaveBeenCalledTimes(1);
    const network = vi.fn<typeof fetch>(async () => { throw new Error("private-key URL secret"); });
    await expect(new HttpLeaderModel({ ...config, fetchImpl: network }).complete(messages, [])).rejects.toThrow("Model transport request failed");
    expect(network).toHaveBeenCalledTimes(1);
  });

  it("bounds stalled body reads even when cancellation never resolves", async () => {
    const stalled = new ReadableStream<Uint8Array>({ cancel: () => new Promise(() => {}) });
    const model = new HttpLeaderModel({ ...config, timeoutMs: 20, fetchImpl: async () => new Response(stalled) });
    await expect(model.complete(messages, [])).rejects.toThrow("timed out");
  });

  it("does not await stuck retry cancellation and honors parent abort", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(new ReadableStream({ cancel: () => new Promise(() => {}) }), { status: 503 }))
      .mockImplementationOnce(async () => ok());
    expect((await new HttpLeaderModel({ ...config, fetchImpl: fetcher }).complete(messages, [])).content).toBe("测试回答");
    const abort = new AbortController(); abort.abort();
    await expect(new HttpLeaderModel({ ...config, fetchImpl: fetcher }).complete(messages, [], abort.signal)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    "bad-json",
    body([], "in_progress"),
    body([], "failed"),
    body([], "completed", { error: { message: "refused" } }),
    body([], "completed", { incomplete_details: { reason: "max_output_tokens" } }),
    body([{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: 123 }] }]),
    body([{ type: "message", role: "user", status: "completed", content: [{ type: "output_text", text: "hi" }] }]),
    body([callOutput("tool-1", "list_nodes", "{}"), callOutput("tool-1", "list_nodes", "{}")]),
    body([callOutput("tool-1", "", "{}")]),
    body([{ type: "function_call", call_id: "tool-1", name: "list_nodes", arguments: 123, status: "completed" }]),
    body([{ type: "reasoning", summary: "not-array" }]),
    body([{ type: "unknown_output_type" }]),
    body([]),
  ])("rejects malformed or incomplete model response %s", async raw => {
    await expect(new HttpLeaderModel({ ...config, fetchImpl: async () => new Response(raw) }).complete(messages, [])).rejects.toThrow("Invalid model response");
  });

  it("enforces response size while reading", async () => {
    await expect(new HttpLeaderModel({ ...config, maxResponseBytes: 64,
      fetchImpl: async () => new Response("x".repeat(65)) }).complete(messages, [])).rejects.toThrow("maximum allowed size");
  });

  it.each(["http://remote.example/v1", "https://user:secret@model.example/v1", "https://model.example/v1?key=secret", "https://model.example/v1#secret"])("rejects unsafe URL %s", baseUrl => {
    expect(() => new HttpLeaderModel({ ...config, baseUrl })).toThrow();
  });

  it("validates time and size bounds and permits local test endpoint", () => {
    expect(() => new HttpLeaderModel({ ...config, timeoutMs: NaN })).toThrow("timeoutMs");
    expect(() => new HttpLeaderModel({ ...config, maxResponseBytes: -1 })).toThrow("maxResponseBytes");
    expect(() => new HttpLeaderModel({ ...config, baseUrl: "http://127.0.0.1:9000/v1" })).not.toThrow();
  });
});
