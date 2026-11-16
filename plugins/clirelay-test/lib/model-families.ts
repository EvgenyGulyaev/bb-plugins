// Семейство модели по её имени/id: только нижний регистр и текстовые
// префиксы/подстроки — SDK не отдаёт стабильный «id семейства».
export const FAMILY_IDS = [
  "gpt",
  "claude",
  "deepseek",
  "grok",
  "gemini",
  "qwen",
  "kimi",
  "llama",
  "mistral",
  "x5",
  "unknown",
] as const;
export type FamilyId = (typeof FAMILY_IDS)[number];

export const FAMILY_LABELS: Record<FamilyId, string> = {
  gpt: "GPT",
  claude: "Claude",
  deepseek: "DeepSeek",
  grok: "Grok",
  gemini: "Gemini",
  qwen: "Qwen",
  kimi: "Kimi",
  llama: "Llama",
  mistral: "Mistral",
  x5: "х5",
  unknown: "Другие",
};

// Порядок важен: х5-префиксы (copilot-x5, x5-airun) проверяются первыми,
// иначе «x5» можно спутать с чужим именем, содержащим те же символы.
const RULES: ReadonlyArray<readonly [FamilyId, (name: string) => boolean]> = [
  ["x5", (name) => name.includes("x5") || name.includes("copilot")],
  ["claude", (name) => name.includes("claude")],
  ["gpt", (name) =>
    name.includes("gpt") || name.includes("codex") || name.includes("chatgpt") || /(^|[-_./])o[134](-|_|\.|$)/.test(name)],
  ["deepseek", (name) => name.includes("deepseek")],
  ["grok", (name) => name.includes("grok")],
  ["gemini", (name) => name.includes("gemini")],
  ["qwen", (name) => name.includes("qwen")],
  ["kimi", (name) => name.includes("kimi") || name.includes("moonshot")],
  ["llama", (name) => name.includes("llama")],
  ["mistral", (name) => name.includes("mistral") || name.includes("mixtral")],
];

/** Семейство по имени или id модели; неизвестное → "unknown". */
export function familyOf(model: string): FamilyId {
  const name = model.trim().toLowerCase();
  for (const [family, matches] of RULES) {
    if (matches(name)) return family;
  }
  return "unknown";
}

export function familyLabel(family: FamilyId): string {
  return FAMILY_LABELS[family];
}

/** Уникальные семейства в порядке FAMILY_IDS (unknown последним). */
export function familiesOf(models: Iterable<string>): FamilyId[] {
  const seen = new Set<FamilyId>();
  for (const model of models) seen.add(familyOf(model));
  return FAMILY_IDS.filter((family) => seen.has(family));
}
