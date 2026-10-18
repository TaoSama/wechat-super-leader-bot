import type pg from "pg";
import { NotificationSourceSchema, readNotification, validateNotificationTime, type Notification, type NotificationSource } from "../notifications/contracts.js";
import { createProgressNotification, progressNotificationBudgetAvailable } from "../notifications/progress.js";
import { notificationCommands, planNotificationRequestIds, goalNotificationRequestIds,
  type NotificationCommandReader } from "../notifications/presentation.js";
import { insertTerminalNotification, notificationFromRow, type NotificationRow } from "./notification-postgres.js";
import { lockNotificationSource } from "./notification-source-postgres.js";

/** Creation consumes a permanent slot, including claims whose delivery is uncertain. */
export async function pgEnqueueProgressNotification(pool: pg.Pool, source: NotificationSource,
  commandReader: (client: pg.PoolClient) => NotificationCommandReader, now = Date.now()): Promise<Notification | null> {
  NotificationSourceSchema.parse(source);
  validateNotificationTime(now);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const record = await lockNotificationSource(client, source);
    if (!record || !progressNotificationBudgetAvailable(record, [], now)) { await client.query("COMMIT"); return null; }
    const column = source.type === "plan" ? "execution_id" : "goal_id";
    const existing = await client.query<NotificationRow>(`SELECT * FROM leader_notifications WHERE ${column}=$1 ORDER BY created_at ASC,id ASC`, [source.id]);
    const notifications = existing.rows.map(notificationFromRow);
    if (!progressNotificationBudgetAvailable(record, notifications, now)) { await client.query("COMMIT"); return null; }
    const commands = await notificationCommands(commandReader(client), "plan" in record ? planNotificationRequestIds(record) : goalNotificationRequestIds(record));
    const notification = createProgressNotification(record, commands, notifications, now);
    if (notification) await insertTerminalNotification(client, notification);
    await client.query("COMMIT");
    return notification ? readNotification(notification, now) : null;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
