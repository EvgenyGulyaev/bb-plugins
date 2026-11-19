export type MessageRegistration = {
  threadId: string;
  turnId: string;
  messageId: string;
  createdAt: number;
};

type Entry = MessageRegistration & { refs: number };

export function createLatestMessageStore() {
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  let version = 0;

  function changed() {
    version += 1;
    for (const listener of listeners) listener();
  }

  return {
    register(input: MessageRegistration): () => void {
      const existing = entries.get(input.messageId);
      entries.set(input.messageId, existing ? { ...input, refs: existing.refs + 1 } : { ...input, refs: 1 });
      changed();
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        const current = entries.get(input.messageId);
        if (!current) return;
        if (current.refs <= 1) entries.delete(input.messageId);
        else entries.set(input.messageId, { ...current, refs: current.refs - 1 });
        changed();
      };
    },
    isLatest(turnKey: string, messageId: string): boolean {
      const candidate = entries.get(messageId);
      if (!candidate || `${candidate.threadId}:${candidate.turnId}` !== turnKey) return false;
      for (const row of entries.values()) {
        if (`${row.threadId}:${row.turnId}` !== turnKey) continue;
        if (row.createdAt > candidate.createdAt || (row.createdAt === candidate.createdAt && row.messageId > messageId)) return false;
      }
      return true;
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getVersion(): number {
      return version;
    },
  };
}
