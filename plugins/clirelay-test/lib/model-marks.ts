import { FAMILY_IDS, type FamilyId } from "./model-families";
import { sanitizeSvg } from "./sanitize-svg";

export type FamilyMark =
  | { kind: "icon"; value: string }
  | { kind: "text"; value: string }
  | { kind: "svg"; value: string };

export const ICON_VALUE_MAX = 64;
export const TEXT_VALUE_MAX = 16;

// Дефолтные марки: у каждого крупного семейства свой глиф BB, у х5 — текст.
export const DEFAULT_MARKS: Record<FamilyId, FamilyMark> = {
  gpt: { kind: "icon", value: "Sparkles" },
  claude: { kind: "icon", value: "MessageSquare" },
  deepseek: { kind: "icon", value: "Brain" },
  grok: { kind: "icon", value: "Zap" },
  gemini: { kind: "icon", value: "Gem" },
  qwen: { kind: "icon", value: "Cloud" },
  kimi: { kind: "icon", value: "Moon" },
  llama: { kind: "icon", value: "Cpu" },
  mistral: { kind: "icon", value: "Wind" },
  x5: { kind: "text", value: "х5" },
  unknown: { kind: "icon", value: "Bot" },
};

/** Проверить и нормализовать марку из kv/RPC; небезопасная → null. */
export function normalizeMark(mark: unknown): FamilyMark | null {
  if (!mark || typeof mark !== "object") return null;
  const record = mark as Record<string, unknown>;
  const value = typeof record.value === "string" ? record.value.trim() : "";
  if (record.kind === "icon") {
    return value && value.length <= ICON_VALUE_MAX ? { kind: "icon", value } : null;
  }
  if (record.kind === "text") {
    return value && value.length <= TEXT_VALUE_MAX ? { kind: "text", value } : null;
  }
  if (record.kind === "svg") {
    const svg = sanitizeSvg(value);
    return svg ? { kind: "svg", value: svg } : null;
  }
  return null;
}

/** Дефолты, поверх которых ложатся сохранённые (только валидные) марки. */
export function resolveMarks(stored: Record<string, unknown> | null | undefined): Record<FamilyId, FamilyMark> {
  const marks: Record<FamilyId, FamilyMark> = { ...DEFAULT_MARKS };
  for (const family of FAMILY_IDS) {
    const mark = normalizeMark(stored?.[family]);
    if (mark) marks[family] = mark;
  }
  return marks;
}

export function markFor(marks: Record<FamilyId, FamilyMark>, family: FamilyId): FamilyMark {
  return marks[family] ?? DEFAULT_MARKS[family];
}
