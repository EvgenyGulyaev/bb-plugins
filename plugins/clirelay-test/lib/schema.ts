import { z } from "zod";

export const API_TYPES = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
] as const;
export const apiTypeSchema = z.enum(API_TYPES);
export type ApiType = (typeof API_TYPES)[number];

export const providerIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "id: строчные буквы/цифры/_/-, до 64 символов");

export const baseUrlSchema = z
  .string()
  .min(1)
  .refine((value) => /^https?:\/\/\S+$/.test(value), "baseUrl: нужен http(s)://адрес");

export const modelIdSchema = z.string().min(1).max(200);

// --- JSON-поля модели (docs/pi models-configuration.md). Loose: неизвестные ключи сохраняются как есть. ---
const levelValue = z.string({ error: "ожидалась строка или null" }).nullable().optional();
export const thinkingLevelMapSchema = z.looseObject({
  off: levelValue, minimal: levelValue, low: levelValue, medium: levelValue,
  high: levelValue, xhigh: levelValue, max: levelValue,
});

// samplingParams свободен по дизайну pi (поля тела запроса) — валидируем только форму объекта.
export const samplingParamsSchema = z.looseObject({});
const samplingLevel = samplingParamsSchema.optional();
export const samplingParamsByThinkingLevelSchema = z.looseObject({
  off: samplingLevel, minimal: samplingLevel, low: samplingLevel, medium: samplingLevel,
  high: samplingLevel, xhigh: samplingLevel, max: samplingLevel,
});

// ponytail: типизировано частое подмножество §Compatibility; остальные поля pi проходят как есть.
// Апгрейд при необходимости — полные per-api схемы.
const compatBool = z.boolean({ error: "ожидалось true/false" }).optional();
export const compatSchema = z.looseObject({
  supportsDeveloperRole: compatBool, supportsStore: compatBool, supportsReasoningEffort: compatBool,
  supportsUsageInStreaming: compatBool, supportsFinishReason: compatBool, supportsLongCacheRetention: compatBool,
  supportsTemperature: compatBool, forceAdaptiveThinking: compatBool, supportsStrictMode: compatBool,
  supportsMidConvoSystemMessages: compatBool,
  maxTokensField: z.enum(["max_completion_tokens", "max_tokens"], { error: "max_completion_tokens или max_tokens" }).optional(),
  thinkingFormat: z.enum(["openai", "openrouter", "deepseek", "together", "baseten", "zai", "qwen", "chat-template", "qwen-chat-template", "string-thinking", "ant-ling"], { error: "неизвестный thinkingFormat" }).optional(),
  promptCacheKeyMode: z.enum(["auto", "enabled", "disabled"], { error: "auto/enabled/disabled" }).optional(),
  thinkingTokenBudgetField: z.enum(["thinking_token_budget", "thinking_budget", "thinking_budget_tokens"], { error: "неизвестное поле бюджета" }).optional(),
  sessionAffinityFormat: z.enum(["openai", "openai-nosession", "openrouter"], { error: "неизвестный формат affinity" }).optional(),
  cacheControlFormat: z.enum(["anthropic"], { error: "только anthropic" }).optional(),
});
export type CompatValue = z.infer<typeof compatSchema>;

// Имена полей §Compatibility по api — только подсказка в UI, не валидация.
export const COMPAT_FIELDS: Record<ApiType, readonly string[]> = {
  "openai-completions": ["supportsStore", "supportsDeveloperRole", "supportsReasoningEffort", "supportsUsageInStreaming", "supportsFinishReason", "maxTokensField", "requiresToolResultName", "requiresAssistantAfterToolResult", "requiresNonNullAssistantContent", "requiresToolsWithToolHistory", "requiresThinkingAsText", "requiresReasoningContentOnAssistantMessages", "thinkingFormat", "chatTemplateKwargs", "chatTemplateArgs", "openRouterRouting", "vercelGatewayRouting", "zaiToolStream", "thinkingTokenBudgetField", "supportsThinkingTokenBudget", "supportsOpenAIGrammarTools", "supportsMidConvoSystemMessages", "supportsMidConvoToolAdditions", "supportsStrictMode", "cacheControlFormat", "sendSessionAffinityHeaders", "sessionAffinityFormat", "promptCacheKeyMode", "supportsLongCacheRetention", "vllmPriority"],
  "openai-responses": ["supportsDeveloperRole", "supportsMidConvoSystemMessages", "sessionAffinityFormat", "promptCacheKeyMode", "supportsLongCacheRetention", "supportsStrictMode", "supportsOpenAIGrammarTools", "supportsAdditionalTools", "supportsToolSearch", "supportsExplicitPromptCacheMode", "supportsMidConvoEffort", "supportsMaxOutputTokens"],
  "anthropic-messages": ["supportsEagerToolInputStreaming", "supportsLongCacheRetention", "sendSessionAffinityHeaders", "sessionAffinityFormat", "supportsCacheControlOnTools", "supportsTemperature", "forceAdaptiveThinking", "allowEmptySignature", "supportsStrictTools", "supportsMidConvoEffort", "supportsMidConvoSystemMessages", "supportsMidConvoToolChanges", "supportsMessageThreads", "allowedFallbackModels"],
  "google-generative-ai": [],
};

const costNumber = z.number({ error: "ожидалось число" }).min(0, "не отрицательное");
const costShape = { input: costNumber, output: costNumber, cacheRead: costNumber, cacheWrite: costNumber };
export const costSchema = z.looseObject({
  ...costShape,
  tiers: z.array(z.looseObject({ inputTokensAbove: z.number().int().min(0), ...costShape })).optional(),
});

export const promptCacheSchema = z.looseObject({
  short: z.number().positive("секунды > 0").optional(),
  long: z.number().positive("секунды > 0").optional(),
});

const limitInt = z.number().int("целое").positive("> 0").optional();
export const inputLimitsSchema = z.looseObject({
  maxRequestBytes: limitInt,
  images: z.looseObject({
    resize: z.looseObject({
      maxWidth: limitInt, maxHeight: limitInt, maxBytes: limitInt,
      jpegQuality: z.number().int().min(0).max(100).optional(),
    }).optional(),
    maxPerMessage: limitInt, maxPerRequest: limitInt,
  }).optional(),
});

// Заголовки — секретные значения: патч мержится по ключам, "" удаляет ключ.
export const headersPatchSchema = z.record(
  z.string().min(1, "имя заголовка не пустое").max(200),
  z.string({ error: "значение — строка" }).max(2000),
);

// null = удалить поле из записи модели; отсутствие = не менять.
// apiKey: "" = очистить (null не принимается); headers: мерж по ключам, null = удалить все.
export const modelPatchSchema = z
  .object({
    name: z.string().min(1).max(200).nullable(),
    reasoning: z.boolean().nullable(),
    contextWindow: z.number().int().positive().nullable(),
    maxTokens: z.number().int().positive().nullable(),
    input: z.array(z.enum(["text", "image"])).min(1).nullable(),
    api: apiTypeSchema.nullable(),
    baseUrl: baseUrlSchema.nullable(),
    thinkingLevelMap: thinkingLevelMapSchema.nullable(),
    samplingParams: samplingParamsSchema.nullable(),
    samplingParamsByThinkingLevel: samplingParamsByThinkingLevelSchema.nullable(),
    compat: compatSchema.nullable(),
    cost: costSchema.nullable(),
    promptCache: promptCacheSchema.nullable(),
    inputLimits: inputLimitsSchema.nullable(),
    apiKey: z.string().max(500),
    headers: headersPatchSchema.nullable(),
  })
  .strict()
  .partial();
export type ModelPatch = z.infer<typeof modelPatchSchema>;

export type ModelFieldType = "string" | "bool" | "int" | "multiselect" | "select" | "json" | "secret" | "headers";
export interface ModelFieldSpec {
  key: keyof ModelPatch;
  label: string;
  type: ModelFieldType;
  placeholder?: string;
  options?: readonly string[];
  hint?: string;
  schema?: z.ZodType;
  advanced?: boolean; // секция «API-настройки», свёрнута по умолчанию
}

export const MODEL_FIELDS: readonly ModelFieldSpec[] = [
  { key: "name", label: "Имя", type: "string" },
  { key: "reasoning", label: "Reasoning (thinking)", type: "bool" },
  { key: "contextWindow", label: "Context window", type: "int", placeholder: "128000" },
  { key: "maxTokens", label: "Max output tokens", type: "int", placeholder: "16384" },
  { key: "input", label: "Вход", type: "multiselect", options: ["text", "image"] },
  { key: "api", label: "API модели", type: "select", options: API_TYPES, advanced: true, hint: "Пусто = тип API провайдера" },
  { key: "baseUrl", label: "baseUrl модели", type: "string", placeholder: "http://host:port/v1", advanced: true, hint: "Пусто = адрес провайдера" },
  { key: "apiKey", label: "API-ключ модели", type: "secret", advanced: true },
  { key: "headers", label: "Заголовки модели", type: "headers", schema: headersPatchSchema, advanced: true, placeholder: '{"X-Api-Key": "$ENV_NAME"}' },
  { key: "thinkingLevelMap", label: "Карта уровней thinking", type: "json", schema: thinkingLevelMapSchema, advanced: true, placeholder: '{"off": null, "low": "low", "high": "high"}', hint: "Ключи: off/minimal/low/medium/high/xhigh/max; null = уровень недоступен; значение — то, что шлётся провайдеру" },
  { key: "samplingParams", label: "Sampling-параметры", type: "json", schema: samplingParamsSchema, advanced: true, placeholder: '{"reasoning_effort": "high"}', hint: "Мержится в каждое тело запроса; только OpenAI-compatible API" },
  { key: "samplingParamsByThinkingLevel", label: "Sampling по уровням thinking", type: "json", schema: samplingParamsByThinkingLevelSchema, advanced: true, placeholder: '{"high": {"reasoning_effort": "high"}}', hint: "Ключи — уровни pi; поверх samplingParams" },
  { key: "compat", label: "Совместимость (compat)", type: "json", schema: compatSchema, advanced: true, placeholder: '{"supportsDeveloperRole": false, "supportsStore": false, "promptCacheKeyMode": "disabled"}', hint: "Неизвестные поля сохраняются как есть" },
  { key: "cost", label: "Стоимость (cost)", type: "json", schema: costSchema, advanced: true, placeholder: '{"input": 1, "output": 5, "cacheRead": 0.1, "cacheWrite": 1.25}', hint: "USD за 1M токенов; input/output/cacheRead/cacheWrite обязательны; tiers — пороги по входу запроса" },
  { key: "promptCache", label: "Кэш промпта (promptCache)", type: "json", schema: promptCacheSchema, advanced: true, placeholder: '{"short": 300, "long": 3600}', hint: "Секунды жизни кэша short/long; pi греет только известные уровни" },
  { key: "inputLimits", label: "Лимиты входа (inputLimits)", type: "json", schema: inputLimitsSchema, advanced: true, placeholder: '{"maxRequestBytes": 10485760}', hint: "maxRequestBytes; images.resize/maxPerMessage/maxPerRequest" },
];

// Валидация JSON-поля формы: parse + zod, ошибка с label и путём. Генерик — типизированный value для ProviderDialog.
export function parseJsonField<S extends z.ZodType>(field: ModelFieldSpec & { schema: S }, raw: string): { ok: true; value: z.infer<S> } | { ok: false; error: string } {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { ok: false, error: `${field.label}: невалидный JSON` }; }
  const result = field.schema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    const path = issue.path.join(".");
    return { ok: false, error: `${field.label}: ${path ? `${path}: ` : ""}${issue.message}` };
  }
  return { ok: true, value: result.data };
}

// Вид провайдера для RPC/фронтенда: без apiKey и значений headers.
export interface ProviderView {
  id: string; name?: string; baseUrl: string; api: string; apiKeySet: boolean;
  authHeader?: boolean; oauth?: string; compat?: Record<string, unknown>;
  headersSet: boolean; headerNames: string[];
  models: Array<{ id: string } & Record<string, unknown>>;
  disabled: Array<{ id: string } & Record<string, unknown>>;
}

// Провайдеры на одном адресе показываются вложенно под общей группой.
export function groupProvidersByBaseUrl(providers: ProviderView[]): Array<{ baseUrl: string; providers: ProviderView[] }> {
  const groups: Array<{ baseUrl: string; providers: ProviderView[] }> = [];
  const byUrl = new Map<string, { baseUrl: string; providers: ProviderView[] }>();
  for (const provider of providers) {
    let group = byUrl.get(provider.baseUrl);
    if (!group) {
      group = { baseUrl: provider.baseUrl, providers: [] };
      byUrl.set(provider.baseUrl, group);
      groups.push(group);
    }
    group.providers.push(provider);
  }
  return groups;
}
