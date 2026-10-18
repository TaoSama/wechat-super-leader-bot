import { afterEach, expect, it, vi } from "vitest";
import pg from "pg";
import { PostgresStore } from "../../src/store/postgres.js";

vi.mock("pg", () => ({ default: { Pool: vi.fn() } }));

const PREVIEW_POINTS = 512;
const STAMP = "2026-10-18T00:00:00.000Z";
type Row = Record<string, unknown>;

function row(overrides: Row = {}): Row {
  return { command_id: "cmd", request_id: "req", node_id: "node", session_id: "thread", action: "send",
    prompt: "task", skills: [], send_route: "control-socket", status: "completed", turn_id: "exact-turn",
    authority: { type: "chat", chatId: "private-chat" }, queue_order: 42,
    has_output: true, output_preview: "😀".repeat(PREVIEW_POINTS), output_truncated: true,
    created_at: STAMP, updated_at: STAMP, expires_at: STAMP, ...overrides };
}

function fixture(rows = [row()]) {
  const query = vi.fn(async (_sql: string, _params: unknown[]) => ({ rows }));
  vi.mocked(pg.Pool).mockImplementation(function () { return { query } as unknown as pg.Pool; });
  return { store: new PostgresStore("postgresql://unused/command-summary"), query };
}

function expectBoundedProjection(sql: string) {
  expect(sql).not.toMatch(/SELECT\s+\*/i);
  expect(sql).not.toMatch(/(?:SELECT|,)\s*output\s*(?:,|FROM)/i);
  expect(sql).toMatch(/output IS NOT NULL AS has_output/i);
  expect(sql).toMatch(/left\(output,\$1\) AS output_preview/i);
  expect(sql).toMatch(/AS output_truncated/i);
}

afterEach(() => vi.restoreAllMocks());

it("projects bounded summaries in SQL and excludes raw output and internal authority from mapped records", async () => {
  const { store, query } = fixture();
  const summaries = await store.listRecentCommandSummaries(50);
  const [sql, params] = query.mock.calls[0];
  expectBoundedProjection(sql);
  expect(sql).toMatch(/ORDER BY created_at DESC LIMIT \$2/);
  expect(params).toEqual([PREVIEW_POINTS, 50]);
  expect(summaries).toHaveLength(1);
  expect(summaries[0]).toMatchObject({ commandId: "cmd", hasOutput: true,
    outputPreview: "😀".repeat(PREVIEW_POINTS), outputTruncated: true });
  for (const key of ["output", "authority", "queueOrder"]) expect(summaries[0]).not.toHaveProperty(key);
});

it.each([
  [false, null, null, false],
  [true, "", false, false],
  [true, "short output", false, false],
  [true, "😀".repeat(PREVIEW_POINTS), true, true],
] as const)("preserves output presence %s and nullable truncation %s", async (hasOutput, preview, truncated, expectedTruncated) => {
  const { store } = fixture([row({ has_output: hasOutput, output_preview: preview, output_truncated: truncated })]);
  expect((await store.listRecentCommandSummaries())[0]).toMatchObject({
    hasOutput, outputPreview: preview ?? "", outputTruncated: expectedTruncated,
  });
});

it("looks up exact request metadata with the bounded projection and keeps full detail retrieval independent", async () => {
  const output = "complete output\n" + "x".repeat(8 * 1024 * 1024);
  const { store, query } = fixture();
  expect((await store.findCommandMetadataByRequestId("req"))?.commandId).toBe("cmd");
  expectBoundedProjection(query.mock.calls[0][0]);
  expect(query.mock.calls[0][0]).toMatch(/WHERE request_id=\$2/);
  expect(query.mock.calls[0][1]).toEqual([PREVIEW_POINTS, "req"]);
  query.mockResolvedValueOnce({ rows: [row({ output })] });
  expect((await store.getCommand("cmd"))?.output).toBe(output);
  expect(query.mock.calls[1]).toEqual(["SELECT * FROM commands WHERE command_id = $1", ["cmd"]]);
});

it("propagates query failures and rejects malformed persisted route metadata", async () => {
  const { store, query } = fixture();
  query.mockRejectedValueOnce(new Error("database unavailable"));
  await expect(store.listRecentCommandSummaries()).rejects.toThrow("database unavailable");
  query.mockResolvedValueOnce({ rows: [row({ send_route: "unknown-route" })] });
  await expect(store.listRecentCommandSummaries()).rejects.toThrow();
});

it("returns null for absent exact metadata and rejects invalid limits before querying", async () => {
  const { store, query } = fixture([]);
  expect(await store.findCommandMetadataByRequestId("missing")).toBeNull();
  query.mockClear();
  for (const limit of [0, -1, 1.5, NaN, 257]) await expect(store.listRecentCommandSummaries(limit)).rejects.toThrow();
  expect(query).not.toHaveBeenCalled();
});
