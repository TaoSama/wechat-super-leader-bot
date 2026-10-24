import { expect, it, vi } from "vitest";
import pg from "pg";
import { PostgresStore } from "../../src/store/postgres.js";
import { normalizeNotification, NOTIFICATION_TTL_MS } from "../../src/notifications/contracts.js";
import { TERMINAL_RESULT_TTL_MS, PROGRESS_RESULT_TTL_MS } from "../../src/notifications/result-collector.js";

vi.mock("pg", () => ({ default: { Pool: vi.fn() } }));
const NOW = 1_700_000_000_000;
const ID = "00000000-0000-4000-8000-000000000001";
function fixture() {
  const notification = normalizeNotification({ id: ID, source: { type: "goal", id: ID }, chatId: "chat",
    kind: "completed", text: "完整成果", createdAt: NOW, expiresAt: NOW + NOTIFICATION_TTL_MS, status: "pending" });
  const row = { id: ID, execution_id: null, goal_id: ID, chat_id: "chat", kind: "completed", status: "pending",
    created_at: String(NOW), expires_at: String(NOW + NOTIFICATION_TTL_MS), data: notification };
  const query = vi.fn(async (_sql: string, _params: unknown[]) => ({ rows: [row] }));
  vi.mocked(pg.Pool).mockImplementation(function () { return { query, on: vi.fn() } as unknown as pg.Pool; });
  return { store: new PostgresStore("postgresql://unused/notification-candidates"), query, row, notification };
}

it("uses bounded ID pagination, independent terminal retention and exact active progress conditions", async () => {
  const { store, query, notification } = fixture();
  expect(await store.listNotificationCandidates(["chat", "chat"], NOW + NOTIFICATION_TTL_MS, ID, 3)).toEqual([notification]);
  const [raw, params] = query.mock.calls[0], sql = raw.replace(/\s+/g, " ");
  expect(params).toEqual([["chat"], NOW + NOTIFICATION_TTL_MS, ID, 3,
    NOW + NOTIFICATION_TTL_MS - TERMINAL_RESULT_TTL_MS, NOW + NOTIFICATION_TTL_MS - PROGRESS_RESULT_TTL_MS]);
  expect(sql).toContain("n.status='pending' AND n.id>$3 AND n.created_at<=$2");
  expect(sql).toContain("n.result_delivery_id IS NULL");
  expect(sql).not.toContain("FROM result_deliveries");
  expect(sql).toContain("n.kind<>'progress' AND COALESCE((n.data->'part'->>'index')::int,1)=1 AND n.created_at>$5");
  expect(sql).toContain("n.kind='progress' AND n.created_at>$6 AND n.expires_at>$2");
  expect(sql).toContain("e.id=n.execution_id AND e.chat_id=n.chat_id AND e.status='active'");
  expect(sql).toContain("g.id=n.goal_id AND g.chat_id=n.chat_id AND g.status='active'");
  expect(sql).toContain("NOT EXISTS (SELECT 1 FROM leader_notifications p");
  expect(sql).toContain("ORDER BY n.id ASC LIMIT $4");
});

it("retrieves every original terminal part by fixed source column and validates persisted row metadata", async () => {
  const { store, query, notification, row } = fixture();
  expect(await store.getNotificationParts({ type: "goal", id: ID })).toEqual([notification]);
  expect(query.mock.calls[0][0]).toContain("WHERE goal_id=$1 AND kind<>'progress'");
  expect(query.mock.calls[0][1]).toEqual([ID]);
  await store.getNotificationParts({ type: "plan", id: ID });
  expect(query.mock.calls[1][0]).toContain("WHERE execution_id=$1 AND kind<>'progress'");
  query.mockResolvedValueOnce({ rows: [{ ...row, chat_id: "wrong" }] });
  await expect(store.listNotificationCandidates(["chat"], NOW)).rejects.toThrow("metadata does not match");
});

it("validates source, cursor, clock and limits before issuing SQL, and skips empty scope", async () => {
  const { store, query } = fixture();
  expect(await store.listNotificationCandidates([], NOW)).toEqual([]);
  await expect(store.listNotificationCandidates(["chat"], -1)).rejects.toThrow();
  await expect(store.listNotificationCandidates(["chat"], NOW, "bad-cursor")).rejects.toThrow();
  await expect(store.listNotificationCandidates(["chat"], NOW, "", 65)).rejects.toThrow();
  await expect(store.getNotificationParts({ type: "goal", id: "bad-source" })).rejects.toThrow();
  expect(query).not.toHaveBeenCalled();
  query.mockRejectedValueOnce(new Error("database unavailable"));
  await expect(store.listNotificationCandidates(["chat"], NOW)).rejects.toThrow("database unavailable");
});
