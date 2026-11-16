// Семейство модели по имени/id — для группировки списков в панели.
import { FAMILY_LABELS, familyOf } from "./model-families";

export function modelFamily(id: string): string {
  return FAMILY_LABELS[familyOf(id)];
}

export function groupByFamily<T extends { id: string }>(items: T[]): Array<{ family: string; items: T[] }> {
  const groups: Array<{ family: string; items: T[] }> = [];
  const byFamily = new Map<string, { family: string; items: T[] }>();
  for (const item of items) {
    const family = modelFamily(item.id);
    let group = byFamily.get(family);
    if (!group) {
      group = { family, items: [] };
      byFamily.set(family, group);
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}
