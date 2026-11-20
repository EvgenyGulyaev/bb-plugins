import { z } from "zod";

// Настройки отображения токенов: что рисовать в строке треда и в бейдже.
// Живут в kv плагина, читаются одним RPC-запросом на окно.
export const TOKENS_DISPLAY_KV_KEY = "tokens-display";
export const TOKENS_DISPLAY_TAG = "tokens-display";

/** Поля строки треда — в порядке вывода. */
export const THREAD_FIELDS = ["total", "speed", "model", "turns", "contextWindow"] as const;
/** Поля бейджа у ответа — в порядке вывода. */
export const BADGE_FIELDS = ["input", "output", "cache", "reasoning", "speed", "model"] as const;
export type ThreadField = (typeof THREAD_FIELDS)[number];
export type BadgeField = (typeof BADGE_FIELDS)[number];

const threadFieldsSchema = z.object({
  total: z.boolean(),
  speed: z.boolean(),
  model: z.boolean(),
  turns: z.boolean(),
  contextWindow: z.boolean(),
}).strict();

const badgeFieldsSchema = z.object({
  input: z.boolean(),
  output: z.boolean(),
  cache: z.boolean(),
  reasoning: z.boolean(),
  speed: z.boolean(),
  model: z.boolean(),
}).strict();

export const tokensDisplaySchema = z.object({
  thread: z.object({ enabled: z.boolean(), fields: threadFieldsSchema }).strict(),
  badge: z.object({ enabled: z.boolean(), fields: badgeFieldsSchema }).strict(),
}).strict();
export type TokensDisplay = z.infer<typeof tokensDisplaySchema>;
export type ThreadFields = TokensDisplay["thread"]["fields"];
export type BadgeFields = TokensDisplay["badge"]["fields"];

/** Патч из вкладки: одна галочка за вызов. */
export const tokensDisplayPatchSchema = z.discriminatedUnion("target", [
  z.object({ target: z.literal("thread"), enabled: z.boolean() }).strict(),
  z.object({ target: z.literal("badge"), enabled: z.boolean() }).strict(),
  z.object({ target: z.literal("threadField"), field: z.enum(THREAD_FIELDS), on: z.boolean() }).strict(),
  z.object({ target: z.literal("badgeField"), field: z.enum(BADGE_FIELDS), on: z.boolean() }).strict(),
]);
export type TokensDisplayPatch = z.infer<typeof tokensDisplayPatchSchema>;

/** Дефолт — ровно прежний вид token-meter: новые поля выключены. */
export const DEFAULT_TOKENS_DISPLAY: TokensDisplay = {
  thread: {
    enabled: true,
    fields: { total: true, speed: true, model: false, turns: false, contextWindow: false },
  },
  badge: {
    enabled: true,
    fields: { input: true, output: true, cache: true, reasoning: false, speed: true, model: false },
  },
};

function pickBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * Kv может хранить мусор или состояние прошлой версии: каждое булево поле
 * берём, только если там boolean, остальное — дефолт. Не бросает.
 */
export function normalizeTokensDisplay(raw: unknown): TokensDisplay {
  const root = asRecord(raw);
  const thread = asRecord(root.thread);
  const badge = asRecord(root.badge);
  const threadFields = asRecord(thread.fields);
  const badgeFields = asRecord(badge.fields);
  const defaults = DEFAULT_TOKENS_DISPLAY;
  const pickFields = <T extends Record<string, boolean>>(source: Record<string, unknown>, base: T): T =>
    Object.fromEntries(Object.entries(base).map(([key, fallback]) => [key, pickBoolean(source[key], fallback)])) as T;
  return {
    thread: {
      enabled: pickBoolean(thread.enabled, defaults.thread.enabled),
      fields: pickFields(threadFields, defaults.thread.fields),
    },
    badge: {
      enabled: pickBoolean(badge.enabled, defaults.badge.enabled),
      fields: pickFields(badgeFields, defaults.badge.fields),
    },
  };
}

/** Чистое применение одного патча: вход не мутируется, результат новый. */
export function applyTokensDisplayPatch(state: TokensDisplay, patch: TokensDisplayPatch): TokensDisplay {
  switch (patch.target) {
    case "thread":
      return { ...state, thread: { ...state.thread, enabled: patch.enabled } };
    case "badge":
      return { ...state, badge: { ...state.badge, enabled: patch.enabled } };
    case "threadField":
      return { ...state, thread: { ...state.thread, fields: { ...state.thread.fields, [patch.field]: patch.on } } };
    case "badgeField":
      return { ...state, badge: { ...state.badge, fields: { ...state.badge.fields, [patch.field]: patch.on } } };
  }
}