import { z } from "zod";
import type { RelayAccount } from "./relay-accounts";
import { accountDisplayName } from "./relay-accounts";

// Кольца квот аккаунтов relay в рейле: чистая логика без DOM и RPC.
export const RINGS_KV_KEY = "relay-rings";
export const RINGS_CHANGED = "relay-rings-changed";
export const RING_SIZE_MIN = 24;
export const RING_SIZE_MAX = 64;
export const RING_SIZE_DEFAULT = 40;
export const RING_PER_ROW_MIN = 1;
export const RING_PER_ROW_MAX = 4;
export const RING_PER_ROW_DEFAULT = 1;
// Ниже этого размера подпись процента не помещается под кольцом.
export const RING_PERCENT_MIN_SIZE = 32;

export interface RingsState {
  selected: string[];
  size: number;
  perRow: number;
}

export interface RingsSource {
  origin: string;
  accounts: RelayAccount[];
}

export interface RingItem {
  key: string;
  origin: string;
  authIndex: string;
  label: string;
  provider: string | null;
  logo: string | null;
  percent: number | null;
  tone: RingTone;
  quotas: RelayAccount["quotas"];
}

export type RingTone = "normal" | "warning" | "critical" | "unknown";

export function clampRingSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return RING_SIZE_DEFAULT;
  return Math.min(RING_SIZE_MAX, Math.max(RING_SIZE_MIN, Math.round(value)));
}

export function clampRingPerRow(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return RING_PER_ROW_DEFAULT;
  return Math.min(RING_PER_ROW_MAX, Math.max(RING_PER_ROW_MIN, Math.round(value)));
}

// kv может хранить что угодно (старая версия плагина, ручная правка) —
// нормализуем к валидному состоянию, а не падаем.
export function normalizeRingsState(raw: unknown): RingsState {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const selected: string[] = [];
  if (Array.isArray(record.selected)) {
    for (const entry of record.selected) {
      if (typeof entry !== "string") continue;
      const trimmed = entry.trim();
      if (!trimmed || selected.includes(trimmed)) continue;
      selected.push(trimmed);
    }
  }
  return {
    selected,
    size: clampRingSize(record.size),
    // Состояние, сохранённое до появления perRow, остаётся в одну колонку.
    perRow: clampRingPerRow(record.perRow),
  };
}

// auth_index — стабильный идентификатор карточки аккаунта (он же ключ списка),
// поэтому он же имя второй половины ключа кольца.
export function ringAccountKey(origin: string, account: { auth_index: string }): string {
  return `${origin}|${account.auth_index}`;
}

export function ringAccountLabel(account: Parameters<typeof accountDisplayName>[0]): string {
  return accountDisplayName(account);
}

export function ringPercent(quotas: RelayAccount["quotas"]): number | null {
  for (const quota of quotas) {
    if (typeof quota.percent !== "number" || !Number.isFinite(quota.percent)) continue;
    return Math.min(100, Math.max(0, Math.round(quota.percent)));
  }
  return null;
}

export function ringTone(percent: number | null): RingTone {
  if (percent === null) return "unknown";
  if (percent <= 5) return "critical";
  if (percent <= 20) return "warning";
  return "normal";
}

// Как у usage-rings: pathLength=100 плюс strokeDasharray «остаток 100».
export function ringDashArray(percent: number): string {
  return `${percent} 100`;
}

// Подпись под кольцом не должна вылезать за ширину кольца: «41%», «100%», «—».
export function ringPercentText(percent: number | null): string {
  return percent === null ? "—" : `${percent}%`;
}

export function ringShowPercent(size: number): boolean {
  return size >= RING_PERCENT_MIN_SIZE;
}

export function ringTitle(label: string, percent: number | null): string {
  return percent === null ? `${label}: квота недоступна` : `${label}: осталось ${percent}%`;
}

const LOGO_MATCHERS: Array<{ logo: string; needles: string[] }> = [
  { logo: "kimi", needles: ["kimi", "moonshot"] },
  { logo: "claude", needles: ["claude", "anthropic"] },
  { logo: "grok", needles: ["grok", "xai"] },
  { logo: "gpt", needles: ["gpt", "openai", "chatgpt"] },
];

// Идентификатор провайдера у relay свободный: ищем вендоренный логотип по
// подстрокам в id/provider/названии аккаунта.
export function providerLogoKey(...values: Array<string | null | undefined>): string | null {
  const haystack = values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toLowerCase())
    .join(" ");
  if (!haystack.trim()) return null;
  for (const matcher of LOGO_MATCHERS) {
    if (matcher.needles.some((needle) => haystack.includes(needle))) return matcher.logo;
  }
  return null;
}

// Выбранные аккаунты в порядке выбора; неразрешённые ключи (адрес удалён,
// аккаунт пропал, нет кредов) просто выпадают.
export function ringItems(selected: string[], sources: RingsSource[]): RingItem[] {
  const byKey = new Map<string, RingItem>();
  for (const source of sources) {
    for (const account of source.accounts) {
      const key = ringAccountKey(source.origin, account);
      const percent = ringPercent(account.quotas);
      byKey.set(key, {
        key,
        origin: source.origin,
        authIndex: account.auth_index,
        label: ringAccountLabel(account),
        provider: account.provider ?? null,
        logo: providerLogoKey(account.provider, account.label, account.email, account.auth_index),
        percent,
        tone: ringTone(percent),
        quotas: account.quotas,
      });
    }
  }
  const items: RingItem[] = [];
  for (const key of selected) {
    const item = byKey.get(key);
    if (item) items.push(item);
  }
  return items;
}

export const ringsStateSchema = z
  .object({
    selected: z.array(z.string()),
    size: z.number(),
    perRow: z.number(),
  })
  .strict();

export const ringsToggleInputSchema = z
  .object({
    key: z.string().min(1).max(400),
    on: z.boolean(),
  })
  .strict();

export const ringsSizeInputSchema = z
  .object({
    size: z.number().refine((value) => Number.isFinite(value), "size: нужно число"),
  })
  .strict();

export const ringsPerRowInputSchema = z
  .object({
    perRow: z.number().refine((value) => Number.isFinite(value), "perRow: нужно число"),
  })
  .strict();
