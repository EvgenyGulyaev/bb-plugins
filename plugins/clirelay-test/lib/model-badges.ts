import { familyOf, type FamilyId } from "./model-families";
import { markFor, type FamilyMark } from "./model-marks";

export interface ThreadModel {
  providerId: string;
  model: string;
  updatedAt: number;
}

export type ThreadModels = Record<string, ThreadModel>;

export interface ThreadBadge {
  providerId: string;
  model: string;
  family: FamilyId;
  mark: FamilyMark;
}

/** Ответ model_badges_state: карта тредов + разрешённые марки семейств. */
export interface BadgesState {
  threads: ThreadModels;
  marks: Record<FamilyId, FamilyMark>;
}

export const PI_PROVIDER_ID = "pi";

/** Обновить модель треда; неизменившееся значение возвращает тот же map. */
export function recordModel(
  threads: ThreadModels,
  threadId: string,
  providerId: string,
  model: string,
  now: number,
): ThreadModels {
  const current = threads[threadId];
  if (current && current.providerId === providerId && current.model === model) return threads;
  return { ...threads, [threadId]: { providerId, model, updatedAt: now } };
}

export function forgetThread(threads: ThreadModels, threadId: string): ThreadModels {
  if (!(threadId in threads)) return threads;
  const next = { ...threads };
  delete next[threadId];
  return next;
}

/**
 * Слить лениво разрешённые модели в карту, не затирая более свежую запись:
 * hook мог обновить тред, пока SDK-разрешение летело.
 */
export function mergeResolved(threads: ThreadModels, resolved: ThreadModels): ThreadModels {
  let next = threads;
  for (const [threadId, entry] of Object.entries(resolved)) {
    const current = next[threadId];
    if (current && current.updatedAt > entry.updatedAt) continue;
    next = recordModel(next, threadId, entry.providerId, entry.model, entry.updatedAt);
  }
  return next;
}

/** Бейдж треда: только pi, только при известной модели, иначе null. */
export function threadBadge(
  threads: ThreadModels,
  marks: Record<FamilyId, FamilyMark>,
  threadId: string,
): ThreadBadge | null {
  const entry = threads[threadId];
  if (!entry || entry.providerId !== PI_PROVIDER_ID || !entry.model) return null;
  const family = familyOf(entry.model);
  return { providerId: entry.providerId, model: entry.model, family, mark: markFor(marks, family) };
}
