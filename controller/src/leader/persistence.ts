import { MAX_COMMAND_IDS, MAX_RECEIPTS, type LeaderData } from "./contracts.js";
import { retainConversation } from "./conversation-history.js";
import { MAX_LEADER_DATA_BYTES } from "./state.js";

/** Bound chat state while keeping the newest durable receipt identities. */
export function retainLeaderData(data: LeaderData): void {
  data.history = retainConversation(data.history);
  data.receipts = data.receipts.slice(-MAX_RECEIPTS);
  data.commandIds = [...new Set(data.commandIds)].slice(-MAX_COMMAND_IDS);
  while (data.history.length && Buffer.byteLength(JSON.stringify(data), "utf8") > MAX_LEADER_DATA_BYTES) {
    data.history = data.history.slice(2);
  }
}
