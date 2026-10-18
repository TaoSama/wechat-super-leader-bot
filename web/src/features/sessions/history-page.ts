import { HistoryItem } from "../../types";

function sameItem(left: HistoryItem, right: HistoryItem): boolean {
  return left.id === right.id && left.turnId === right.turnId && left.kind === right.kind &&
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
  const unique = [...new Map(incoming.map(item => [item.id, item])).values()];
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
  if (!changed) return current;
  const result: HistoryItem[] = [];
  for (let link = head; link; link = link.next) result.push(link.item);
  return result;
}
