import type { HistoryItem } from "../../types";

export interface HistoryTurn {
  key: string;
  items: HistoryItem[];
  tools: HistoryItem[];
  status?: HistoryItem["turnStatus"];
}

// A missing turn status or a page boundary does not prove that a turn ended.
export function historyTurns(items: HistoryItem[], gapBeforeIds: string[]): HistoryTurn[] {
  const gaps = new Set(gapBeforeIds);
  const turns: HistoryTurn[] = [];
  for (const item of items) {
    let turn = turns.at(-1);
    if (!item.turnId || turn?.items[0].turnId !== item.turnId || gaps.has(item.id)) {
      turn = { key: item.id, items: [], tools: [] };
      turns.push(turn);
    }
    turn!.items.push(item);
    if (item.kind === "tool") turn!.tools.push(item);
  }
  const occurrences = new Map<string, number>();
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index];
    const id = turn.items[0].turnId;
    const occurrence = occurrences.get(id) ?? 0;
    occurrences.set(id, occurrence + 1);
    turn.key = id ? JSON.stringify([id, occurrence]) : turn.items[0].id;
    const statuses = new Set(turn.items.map(item => item.turnStatus));
    if (statuses.size === 1 && !statuses.has(undefined)) {
      turn.status = turn.items[0].turnStatus;
    }
  }
  return turns;
}
