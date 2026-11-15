/** The fields the board tree needs from a sidebar thread. */
export interface BoardThreadRef {
  id: string;
  parentThreadId: string | null;
  createdAt: number;
}

/** One board card: a top-level thread and every thread nested under it. */
export interface BoardCard<Thread extends BoardThreadRef> {
  thread: Thread;
  /** Descendants, flattened: a grandchild sits next to its parent. */
  children: Thread[];
}

/**
 * The thread at the top of `thread`'s parent chain, or null when the chain
 * loops. A parent that is not on the board ends the walk where it stops, so a
 * thread whose parent was archived keeps a card of its own.
 */
function topOf<Thread extends BoardThreadRef>(
  thread: Thread,
  byId: ReadonlyMap<string, Thread>,
): Thread | null {
  const seen = new Set<string>([thread.id]);
  let current = thread;
  while (current.parentThreadId !== null) {
    const parent = byId.get(current.parentThreadId);
    if (parent === undefined) return current;
    if (seen.has(parent.id)) return null;
    seen.add(parent.id);
    current = parent;
  }
  return current;
}

function compareChildren(a: BoardThreadRef, b: BoardThreadRef): number {
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Group board threads into cards: a thread whose parent is on the board is
 * drawn inside the parent's card instead of as a card of its own, however deep
 * the chain goes. Cards keep the order they arrive in, children are sorted by
 * creation time, and a parent cycle cannot drop a thread from the board — each
 * member of the loop falls back to a card of its own.
 */
export function groupBoardThreads<Thread extends BoardThreadRef>(
  threads: readonly Thread[],
): BoardCard<Thread>[] {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const rootIdOf = new Map<string, string>();
  for (const thread of threads) {
    const top = topOf(thread, byId);
    rootIdOf.set(thread.id, top === null ? thread.id : top.id);
  }

  const cards: BoardCard<Thread>[] = [];
  const byRoot = new Map<string, BoardCard<Thread>>();
  for (const thread of threads) {
    if (rootIdOf.get(thread.id) !== thread.id) continue;
    const card: BoardCard<Thread> = { thread, children: [] };
    byRoot.set(thread.id, card);
    cards.push(card);
  }
  for (const thread of threads) {
    const rootId = rootIdOf.get(thread.id);
    if (rootId === undefined || rootId === thread.id) continue;
    byRoot.get(rootId)?.children.push(thread);
  }
  for (const card of cards) card.children.sort(compareChildren);
  return cards;
}
