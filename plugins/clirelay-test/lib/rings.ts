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
// Тот же зазор, что рисует сетка колец в app.css.
export const RING_GAP = 4;
// Синхронно с padding:3px у .relay-rings-list в app.css: замер outer-ширины
// переводится в content-ширину вычитанием padding с двух сторон.
export const RING_LIST_PADDING = 3;
// Меньше этого кольцо уже не читается; лучше чуть выйти за рейл, чем исчезнуть.
export const RING_DISPLAY_MIN_SIZE = 12;

export interface RingsState {
  selected: string[];
  size: number;
  perRow: number;
}

export interface RingsSource {
  origin: string;
  accounts: RelayAccount[];
}

export interface RingAccountEntry {
  key: string;
  label: string;
  disabled: boolean;
  percent: number | null;
  quotas: RelayAccount["quotas"];
}

export interface RingItem {
  // Ключ кольца = ключ типа провайдера (стабильный), а не аккаунта.
  key: string;
  type: string;
  label: string;
  logo: string | null;
  percent: number | null;
  tone: RingTone;
  // Сколько аккаунтов типа активно (не disabled) — для title и попавера.
  activeCount: number;
  // Выбранные аккаунты типа: активные первыми, затем по убыванию остатка.
  accounts: RingAccountEntry[];
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

// Рейл узкий (~40px), поэтому в несколько колонок кольцо должно ужаться под
// ширину якоря; до первого замера (railWidth 0/NaN) отдаём размер из настройки.
export function effectiveRingSize(railWidth: number, perRow: number, setting: number, gap: number = RING_GAP): number {
  const wanted = typeof setting === "number" && Number.isFinite(setting) ? setting : RING_SIZE_DEFAULT;
  if (typeof railWidth !== "number" || !Number.isFinite(railWidth) || railWidth <= 0) {
    return Math.min(RING_SIZE_MAX, Math.max(RING_DISPLAY_MIN_SIZE, wanted));
  }
  const columns = clampRingPerRow(perRow);
  const available = Math.floor((railWidth - (columns - 1) * gap) / columns);
  const size = Math.min(wanted, available);
  return Math.min(RING_SIZE_MAX, Math.max(RING_DISPLAY_MIN_SIZE, size));
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
// Видна всегда: при мелком кольце CSS уменьшает её, а не прячет.
export function ringPercentText(percent: number | null): string {
  return percent === null ? "—" : `${percent}%`;
}

export function ringTitle(label: string, percent: number | null, activeCount = 0): string {
  if (percent === null) return `${label}: квота недоступна`;
  return activeCount > 1
    ? `${label}: осталось ${percent}% (больший активный из ${activeCount})`
    : `${label}: осталось ${percent}%`;
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

// Тип аккаунта: вендор из маппинга логотипов, иначе нормализованный id
// провайдера — два аккаунта без логотипа одного провайдера тоже схлопываются.
export function providerType(account: RelayAccount): string {
  const logo = providerLogoKey(account.provider, account.label, account.email, account.auth_index);
  if (logo !== null) return logo;
  const id = account.provider?.trim().toLowerCase();
  return id ? id : "other";
}

export function providerTypeLabel(type: string): string {
  const known = TYPE_LABELS[type];
  if (known) return known;
  return type === "other" ? "Другие" : type.charAt(0).toUpperCase() + type.slice(1);
}

// Отображаемое имя типа: без почты и хэшей аккаунта.
const TYPE_LABELS: Record<string, string> = {
  kimi: "Kimi",
  claude: "Claude",
  grok: "Grok",
  gpt: "GPT",
};

// Одно кольцо на тип провайдера. Percent — максимум остатка среди АКТИВНЫХ
// аккаунтов типа («больший активный»): одно выключенное ведро с 90% не должно
// выглядеть как доступная квота. Неразрешённые ключи (адрес удалён, аккаунт
// пропал, нет кредов) выпадают; порядок колец — по первому выбранному аккаунту.
export function ringItems(selected: string[], sources: RingsSource[]): RingItem[] {
  const byKey = new Map<string, { origin: string; account: RelayAccount }>();
  for (const source of sources) {
    for (const account of source.accounts) {
      byKey.set(ringAccountKey(source.origin, account), { origin: source.origin, account });
    }
  }

  const groups = new Map<string, { type: string; entries: RingAccountEntry[] }>();
  for (const key of selected) {
    const found = byKey.get(key);
    if (!found) continue;
    const { account } = found;
    const type = providerType(account);
    let group = groups.get(type);
    if (!group) {
      group = { type, entries: [] };
      groups.set(type, group);
    }
    group.entries.push({
      key,
      label: ringAccountLabel(account),
      disabled: account.disabled,
      percent: ringPercent(account.quotas),
      quotas: account.quotas,
    });
  }

  const items: RingItem[] = [];
  for (const group of groups.values()) {
    const active = group.entries.filter((entry) => !entry.disabled);
    const percents = active
      .map((entry) => entry.percent)
      .filter((percent): percent is number => percent !== null);
    const percent = percents.length > 0 ? Math.max(...percents) : null;
    const sample = byKey.get(group.entries[0]!.key)!.account;
    items.push({
      key: group.type,
      type: group.type,
      label: providerTypeLabel(group.type),
      logo: providerLogoKey(sample.provider, sample.label, sample.email, sample.auth_index),
      percent,
      tone: ringTone(percent),
      activeCount: active.length,
      accounts: [...active, ...group.entries.filter((entry) => entry.disabled)]
        .sort(byEntryOrder),
    });
  }
  return items;
}

// Активные сначала, внутри — по убыванию остатка; без процента — в конце.
function byEntryOrder(a: RingAccountEntry, b: RingAccountEntry): number {
  if (a.disabled !== b.disabled) return a.disabled ? 1 : -1;
  if (a.percent === b.percent) return 0;
  if (a.percent === null) return 1;
  if (b.percent === null) return -1;
  return b.percent - a.percent;
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
