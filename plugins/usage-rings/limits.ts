export interface UsageWindow {
  label: string;
  usedPercent: number;
  resetsAt: string | null;
}

export interface ProviderPreference {
  id: string;
  enabled: boolean;
}

export function selectWindow(windows: readonly UsageWindow[]): UsageWindow | null {
  return windows.find(w => /^(Five-hour limit|5 hours?|5h)$/i.test(w.label))
    ?? windows.find(w => /^Five-hour limit · /i.test(w.label))
    ?? windows.find(w => /^(Weekly limit|Weekly|7d)$/i.test(w.label))
    ?? windows.find(w => /^Weekly\b/i.test(w.label))
    ?? null;
}

export function remainingPercent(window: UsageWindow): number {
  return Math.round(Math.max(0, Math.min(100, 100 - window.usedPercent)));
}

export function orderedProviders<T extends { id: string }>(providers: readonly T[], preferences: readonly ProviderPreference[]): T[] {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const ordered = preferences.flatMap(({ id }) => {
    const provider = byId.get(id);
    byId.delete(id);
    return provider ? [provider] : [];
  });
  return [...ordered, ...byId.values()];
}
