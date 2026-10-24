import { ACTIVE_COMMAND_STATUSES } from "../commands/queue.js";

/** Recent identity cache, never an archive or proof that a target is currently sendable. */
export const KNOWN_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
/** Soft total limit: current inventories and unfinished business references may exceed it. */
export const KNOWN_SESSION_LIMIT = 4096;
export const KNOWN_SESSION_COMMAND_STATUSES = ["admitting", "queued", ...ACTIVE_COMMAND_STATUSES];
export const KNOWN_SESSION_CLEANUP_BATCH_SIZE = 256;

export type LiveSessionIds = ReadonlyMap<string, ReadonlySet<string>>;
