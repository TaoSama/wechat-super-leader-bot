import { HistoryItem, SessionHistory } from "../../types";

function sameItem(left: HistoryItem, right: HistoryItem): boolean {
  return left.id === right.id && left.turnId === right.turnId && left.turnStatus === right.turnStatus && left.kind === right.kind &&
    left.type === right.type && left.text === right.text && left.title === right.title &&
    left.status === right.status && left.timestamp === right.timestamp && left.truncated === right.truncated;
}

interface Link { item: HistoryItem; next: Link | null; previous: Link | null }

// Existing rows keep their order. New rows are inserted before the next known
// row in the page, or after the preceding row when the page extends the tail.
export function mergeHistoryPage(current: HistoryItem[], incoming: HistoryItem[], insertion: number): HistoryItem[] {
  const links = new Map<string, Link>();
  let head: Link | null = null;
  let tail: Link | null = null;
  for (const item of current) {
    const link: Link = { item, previous: tail, next: null };
    if (tail) tail.next = link; else head = link;
    tail = link;
    links.set(item.id, link);
  }
  const nativeItems = [...new Map(incoming.map(item => [item.id, item])).values()];
  const turnStatuses = new Map<string, Set<HistoryItem["turnStatus"]>>();
  for (const item of nativeItems) {
    if (!item.turnId || !item.turnStatus) continue;
    const statuses = turnStatuses.get(item.turnId) ?? new Set();
    statuses.add(item.turnStatus);
    turnStatuses.set(item.turnId, statuses);
  }
  const unique = nativeItems.map(item => {
    const previousStatus = links.get(item.id)?.item.turnStatus;
    return item.turnStatus === undefined && previousStatus !== undefined ? { ...item, turnStatus: previousStatus } : item;
  });
  const following: Array<Link | null> = new Array(unique.length);
  let next: Link | null = null;
  for (let index = unique.length - 1; index >= 0; index--) {
    following[index] = next;
    next = links.get(unique[index].id) ?? next;
  }
  let position = links.get(current[insertion]?.id) ?? null;
  let changed = false;
  for (let index = 0; index < unique.length; index++) {
    const item = unique[index];
    const existing = links.get(item.id);
    if (existing) {
      if (!sameItem(existing.item, item)) { existing.item = item; changed = true; }
      position = existing.next;
      continue;
    }
    const anchor = following[index] ?? position;
    const previous = anchor ? anchor.previous : tail;
    const link: Link = { item, previous, next: anchor };
    if (previous) previous.next = link; else head = link;
    if (anchor) anchor.previous = link; else tail = link;
    links.set(item.id, link);
    position = anchor;
    changed = true;
  }
  // Tail pages can carry the completion of a turn whose earlier rows are in
  // retained pages. Apply that exact native status to the same turn only.
  for (const link of links.values()) {
    const statuses = turnStatuses.get(link.item.turnId);
    if (statuses?.size !== 1) continue;
    const status = [...statuses][0];
    if (link.item.turnStatus !== status) { link.item = { ...link.item, turnStatus: status }; changed = true; }
  }
  if (!changed) return current;
  const result: HistoryItem[] = [];
  for (let link = head; link; link = link.next) result.push(link.item);
  return result;
}

export function applyHistoryTurnStatuses(items: HistoryItem[], statuses?: SessionHistory["turnStatuses"]): HistoryItem[] {
  if (!statuses) return items;
  let changed = false;
  const result = items.map(item => {
    const status = Object.hasOwn(statuses, item.turnId) ? statuses[item.turnId] : undefined;
    if (!status || item.turnStatus === status) return item;
    changed = true;
    return { ...item, turnStatus: status };
  });
  return changed ? result : items;
}
