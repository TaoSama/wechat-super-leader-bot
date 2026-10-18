import type { CommandStatus } from "../../types";

export type CommandFilter = CommandStatus | "ALL" | "attention" | "running";

const FILTER_STATUSES: Record<"attention" | "running", readonly CommandStatus[]> = {
  attention: ["uncertain", "failed", "input-written", "expired"],
  running: ["queued", "pending", "accepted"],
};

export function matchesCommandFilter(status: CommandStatus, filter: CommandFilter): boolean {
  if (filter === "ALL") return true;
  if (filter === "attention" || filter === "running") return FILTER_STATUSES[filter].includes(status);
  return status === filter;
}
