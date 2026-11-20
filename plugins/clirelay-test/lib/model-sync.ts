import type { ModelEntry } from "./models-file";

/** Ключи, которые переносим из donor. Только они; остальное в donor не трогаем. */
export const DONOR_FIELDS = [
  "api",
  "baseUrl",
  "apiKey",
  "headers",
  "reasoning",
  "thinkingLevelMap",
  "input",
  "samplingParams",
  "samplingParamsByThinkingLevel",
  "compat",
  "cost",
  "promptCache",
  "inputLimits",
] as const;

export const INPUT_VALUE_LIMIT = { text: 10_000_000, image: 10_000_000 } as const;
export const CONTEXT_LIMIT = 10_000_000;
export const MAX_TOKENS_LIMIT = 1_000_000;

const KNOWN_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const LEVEL_SET = new Set<string>(KNOWN_LEVELS);

export type InputModality = "text" | "image";
export type ThinkingLevel = (typeof KNOWN_LEVELS)[number];
export type LimitSource = "api" | "donor" | "default";

export interface ParsedId {
  family: string;
  version: number[];
  variant: string;
}

export interface DonorEntry {
  id: string;
  enabled: boolean;
}

export interface DonorMatch {
  donor: string | null;
  candidates: DonorEntry[];
  /**
   * Почему нет автодонора: `duplicate` — id повторяется в pool (значения
   * неизвестны), `tie` — равный максимум версии у разных id. При `tie` ручной
   * выбор любого кандидата допустим, при `duplicate` — нет.
   */
  ambiguous?: "tie" | "duplicate";
}

const VERSION = /v?(?:\d+(?:\.\d+)+|\d+-\d+|\d+)/g;

/**
 * Детерминированный парсер id по §4.1: первая версия слева, ограниченная
 * началом/`-` слева и `-`/`:`/концом справа. Никаких эвристик и LLM.
 */
export function parseModelId(raw: string): ParsedId | null {
  const id = raw.toLowerCase();
  VERSION.lastIndex = 0;
  for (let match = VERSION.exec(id); match; match = VERSION.exec(id)) {
    const start = match.index;
    const end = start + match[0].length;
    const before = start === 0 ? "" : id[start - 1]!;
    const after = end === id.length ? "" : id[end]!;
    if (before && before !== "-") continue;
    if (after && after !== "-" && after !== ":") continue;
    const family = id.slice(0, start).replace(/-$/, "");
    if (!family) return null;
    const version = match[0].replace(/^v/, "").replace(/-/g, ".").split(".").map(Number);
    const rest = id.slice(end);
    const variant = rest.startsWith("-") ? rest.slice(1) : rest;
    return { family, version, variant };
  }
  return null;
}

function compareVersions(left: number[], right: number[]): number {
  const size = Math.max(left.length, right.length);
  for (let index = 0; index < size; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

/**
 * Подбор donor по §4.2. `candidates` заполняется только при ambiguity и не
 * сосуществует с `donor` (контракт §7).
 */
export function matchDonor(newId: string, pool: DonorEntry[]): DonorMatch {
  const target = parseModelId(newId);
  if (!target) return { donor: null, candidates: [] };

  const matching = new Map<string, { entry: DonorEntry; version: number[] }>();
  let duplicated = false;
  for (const entry of pool) {
    const parsed = parseModelId(entry.id);
    if (!parsed || parsed.family !== target.family || parsed.variant !== target.variant) continue;
    if (matching.has(entry.id)) duplicated = true;
    else matching.set(entry.id, { entry, version: parsed.version });
  }
  if (matching.size === 0) return { donor: null, candidates: [] };
  if (duplicated) return { donor: null, candidates: sortCandidates([...matching.values()]), ambiguous: "duplicate" };

  const values = [...matching.values()];
  // Версия >= новой — это не upgrade: donor и candidates отсутствуют.
  if (values.some((item) => compareVersions(item.version, target.version) >= 0)) return { donor: null, candidates: [] };

  let best: { entry: DonorEntry; version: number[] } | undefined;
  let tie = false;
  for (const item of values) {
    if (!best) {
      best = item;
      continue;
    }
    const order = compareVersions(item.version, best.version);
    if (order > 0) {
      best = item;
      tie = false;
    } else if (order === 0) tie = true;
  }
  if (tie || !best) return { donor: null, candidates: sortCandidates(values), ambiguous: "tie" };
  return { donor: best.entry.id, candidates: [] };
}

function sortCandidates(values: Array<{ entry: DonorEntry; version: number[] }>): DonorEntry[] {
  return values
    .slice()
    .sort((left, right) => compareVersions(right.version, left.version) || (left.entry.id < right.entry.id ? -1 : left.entry.id > right.entry.id ? 1 : 0))
    .map((item) => ({ id: item.entry.id, enabled: item.entry.enabled }));
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Структурный deep clone donor по §5.2: только whitelist, без id/name и
 * неизвестных полей. Top-level null/undefined и пустой apiKey не создаём.
 */
export function cloneDonorEntry(donor: ModelEntry, id: string): ModelEntry {
  const entry: ModelEntry = { id };
  for (const field of DONOR_FIELDS) {
    const value = donor[field];
    if (value === undefined || value === null) continue;
    // Пустые строки переносить бессмысленно: api/baseUrl/apiKey — только реальные значения.
    if ((field === "apiKey" || field === "api" || field === "baseUrl") && (typeof value !== "string" || value.length === 0)) continue;
    if (field === "headers" && (!plainObject(value) || Object.keys(value).length === 0)) continue;
    entry[field] = structuredClone(value);
  }
  return entry;
}

function positiveSafeInteger(value: unknown, limit?: number): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return undefined;
  return limit !== undefined && value > limit ? undefined : value;
}

export type LimitField = "contextWindow" | "maxTokens";

/** Всё, что нужно для fallback: лимиты и input донора (UI и ModelEntry подходят оба). */
export interface DonorLike { [key: string]: unknown }

/**
 * §5.3: надёжное API-значение → donor → omitted. Donor не ограничиваем
 * API upper bound и не чиним молча.
 */
export function effectiveLimit(
  apiValue: number | undefined,
  donor: DonorLike | undefined,
  field: LimitField,
): { value?: number; source: LimitSource } {
  const limit = field === "contextWindow" ? CONTEXT_LIMIT : MAX_TOKENS_LIMIT;
  const fromApi = positiveSafeInteger(apiValue, limit);
  if (fromApi !== undefined) return { value: fromApi, source: "api" };
  const fromDonor = positiveSafeInteger(donor?.[field]);
  if (fromDonor !== undefined) return { value: fromDonor, source: "donor" };
  return { source: "default" };
}

export function inputModalities(value: unknown): InputModality[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: InputModality[] = [];
  for (const item of value) {
    if ((item === "text" || item === "image") && !result.includes(item)) result.push(item);
  }
  return result.length > 0 ? result : undefined;
}

/** §5.3: валидный API input → non-empty donor input → omitted. */
export function effectiveInput(
  apiValue: InputModality[] | undefined,
  donor: DonorLike | undefined,
): { value?: InputModality[]; source: LimitSource } {
  const fromApi = inputModalities(apiValue);
  if (fromApi) return { value: fromApi, source: "api" };
  const fromDonor = inputModalities(donor?.input);
  if (fromDonor) return { value: fromDonor, source: "donor" };
  return { source: "default" };
}

/**
 * §5.3 reasoning: без уровней сохраняем donor reasoning/map как есть.
 * С уровнями — `reasoning = any(level !== "off")`, `off` не выключаем,
 * неподдерживаемые известные уровни → null, поддерживаемые без donor
 * mapping не выдумываем.
 */
export function effectiveReasoning(
  levels: readonly string[] | undefined,
  donor: ModelEntry | undefined,
): { reasoning: boolean; thinkingLevelMap?: Record<string, unknown> } {
  if (!levels) {
    const map = plainObject(donor?.thinkingLevelMap) ? structuredClone(donor.thinkingLevelMap) : undefined;
    return { reasoning: donor?.reasoning === true, ...(map ? { thinkingLevelMap: map } : {}) };
  }
  const supported = new Set(levels);
  const map: Record<string, unknown> = plainObject(donor?.thinkingLevelMap) ? structuredClone(donor.thinkingLevelMap) : {};
  for (const level of KNOWN_LEVELS) {
    if (level === "off") continue; // off всегда оставляем доступным
    if (!supported.has(level)) map[level] = null;
  }
  return {
    reasoning: levels.some((level) => level !== "off"),
    ...(Object.keys(map).length > 0 ? { thinkingLevelMap: map } : {}),
  };
}

/** pi-дефолты §5.3 — только для подписи в диалоге подтверждения. */
export const PI_DEFAULT_CONTEXT_WINDOW = 128_000;
export const PI_DEFAULT_MAX_TOKENS = 16_384;

export interface EffectiveField<T> { value: T; source: LimitSource; label: string }
export interface EffectiveView {
  contextWindow: EffectiveField<number>;
  maxTokens: EffectiveField<number>;
  input: EffectiveField<InputModality[]>;
}

const LABELS: Record<LimitSource, string> = { api: "API", donor: "donor fallback", default: "pi default" };

/**
 * §3.3: итоговые contextWindow/maxTokens/input с источником для диалога.
 * Только витрина — apply всё равно пересчитывает значения на сервере.
 */
export function effectiveView(view: {
  contextWindow?: number;
  maxTokens?: number;
  input?: readonly string[];
  donor?: { contextWindow?: number; maxTokens?: number; input?: readonly string[] };
}): EffectiveView {
  const contextWindow = effectiveLimit(view.contextWindow, view.donor, "contextWindow");
  const maxTokens = effectiveLimit(view.maxTokens, view.donor, "maxTokens");
  const input = effectiveInput(view.input as InputModality[] | undefined, view.donor);
  return {
    contextWindow: {
      value: contextWindow.value ?? PI_DEFAULT_CONTEXT_WINDOW,
      source: contextWindow.source,
      label: LABELS[contextWindow.source],
    },
    maxTokens: {
      value: maxTokens.value ?? PI_DEFAULT_MAX_TOKENS,
      source: maxTokens.source,
      label: LABELS[maxTokens.source],
    },
    input: { value: input.value ?? ["text"], source: input.source, label: LABELS[input.source] },
  };
}
