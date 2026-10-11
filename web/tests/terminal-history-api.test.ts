import { afterEach, describe, expect, it, vi } from "vitest";
import { Buffer } from "node:buffer";
import { fetchSessionHistory, normalizeControlPlaneStatus } from "../src/api";
import { emptyExecutions } from "./status-fixtures";

const SESSION_ID = "terminal:" + Buffer.alloc(32, 7).toString("base64url");
const session = { id: SESSION_ID, provider: "terminal/codex", loaded: false, capabilities: ["read"],
  historySource: "terminal-transcript", observedAt: "2026-10-12T12:00:00Z" };
const page = { session, historyContext: "cf7e282f-d6d2-4a98-a517-9fb753f2549b", source: "terminal-transcript",
  items: [{ id: "record", turnId: "", type: "transcript_message", kind: "assistant", text: "可见内容" }],
  nextCursor: null, fetchedAt: session.observedAt, truncated: false };
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
afterEach(() => vi.unstubAllGlobals());

describe("terminal history API isolation", () => {
  it.each(["codex", "claude", "grok"])("normalizes the %s marker without granting send or loaded state", provider => {
    const status = normalizeControlPlaneStatus({ nodes: [], commands: [], executions: emptyExecutions(),
      sessions: [{ ...session, provider: `terminal/${provider}`, nodeId: "node" }] });
    expect(status.sessions[0]).toMatchObject({ historySource: "terminal-transcript", capabilities: ["read"], loaded: false });
    expect(status.sessions[0].sendAvailability).toBeUndefined();
  });

  it.each([
    { historySource: undefined }, { historySource: "codex-desktop" }, { provider: "terminal/unknown" },
    { provider: "codex-app" }, { id: "native" }, { id: `terminal:${"a".repeat(43)}` }, { id: SESSION_ID + "\n" },
  ])("does not preserve an invalid history marker %#", change => {
    const status = normalizeControlPlaneStatus({ nodes: [], commands: [], executions: emptyExecutions(),
      sessions: [{ ...session, ...change, nodeId: "node" }] });
    expect(status.sessions[0].historySource).toBeUndefined();
  });

  it("accepts original CLI visible records with an empty, unclaimed native turn ID", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(page)));
    expect(await fetchSessionHistory("node", SESSION_ID)).toMatchObject({ source: "terminal-transcript",
      session: { historySource: "terminal-transcript", loaded: false }, items: [{ turnId: "", text: "可见内容" }] });
  });

  it.each([
    { source: "control-socket" }, { source: "codex-desktop" },
    { session: { ...session, historySource: undefined } },
    { session: { ...session, provider: "terminal/unsupported" } },
    { items: [{ ...page.items[0], kind: "system", type: "terminalSnapshot" }] },
    { items: [{ ...page.items[0], kind: "tool" }] },
    { items: [{ ...page.items[0], type: "terminalSnapshot" }] },
    { items: [{ ...page.items[0], type: "unknown" }] },
  ])("rejects wrong routes and non-dialogue snapshot items %#", async change => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ ...page, ...change })));
    await expect(fetchSessionHistory("node", SESSION_ID)).rejects.toThrow();
  });

  it("rejects terminal history from a native ID", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ ...page,
      session: { ...session, id: "native", provider: "codex-app", historySource: undefined } })));
    await expect(fetchSessionHistory("node", "native")).rejects.toThrow("来源不匹配");
  });
});
