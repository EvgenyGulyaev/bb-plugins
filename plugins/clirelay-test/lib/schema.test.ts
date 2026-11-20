import { describe, expect, it } from "vitest";
import {
  COMPAT_FIELDS, compatSchema, costSchema, groupProvidersByBaseUrl, headersPatchSchema, inputLimitsSchema,
  MODEL_FIELDS, modelPatchSchema, parseJsonField, promptCacheSchema, providerIdSchema,
  samplingParamsByThinkingLevelSchema, samplingParamsSchema, thinkingLevelMapSchema,
  type ProviderView,
} from "./schema";

const view = (id: string, baseUrl: string): ProviderView => ({ id, baseUrl, api: "openai-completions", apiKeySet: true, headersSet: false, headerNames: [], models: [], disabled: [] });

describe("groupProvidersByBaseUrl", () => {
  it("одинаковый адрес → одна группа, порядок провайдеров и групп сохранён", () => {
    const groups = groupProvidersByBaseUrl([
      view("a", "http://localhost:4010/v1"),
      view("b", "http://localhost:4010/v1"),
      view("c", "http://localhost:4011/v1"),
    ]);
    expect(groups.map((g) => g.baseUrl)).toEqual(["http://localhost:4010/v1", "http://localhost:4011/v1"]);
    expect(groups[0]!.providers.map((p) => p.id)).toEqual(["a", "b"]);
    expect(groups[1]!.providers.map((p) => p.id)).toEqual(["c"]);
  });
  it("пустой список → пусто", () => {
    expect(groupProvidersByBaseUrl([])).toEqual([]);
  });
});

describe("modelPatchSchema", () => {
  it("принимает типы полей и null-удаление", () => {
    const patch = { reasoning: true, contextWindow: 400000, input: ["text", "image"], name: null };
    expect(modelPatchSchema.parse(patch)).toEqual(patch);
  });
  it("отклоняет неверные типы, пустой input, неизвестные поля", () => {
    expect(modelPatchSchema.safeParse({ contextWindow: "много" }).success).toBe(false);
    expect(modelPatchSchema.safeParse({ reasoning: 1 }).success).toBe(false);
    expect(modelPatchSchema.safeParse({ input: [] }).success).toBe(false);
    expect(modelPatchSchema.safeParse({ modelOverrides: {} }).success).toBe(false);
  });
  it("форма покрывает все поля патча; базовые пять не изменились", () => {
    expect(MODEL_FIELDS.slice(0, 5).map((f) => [f.key, f.type])).toEqual([
      ["name", "string"], ["reasoning", "bool"], ["contextWindow", "int"], ["maxTokens", "int"], ["input", "multiselect"],
    ]);
    expect(MODEL_FIELDS.map((f) => f.key).sort()).toEqual(Object.keys(modelPatchSchema.shape).sort());
  });
});

describe("API-поля модели", () => {
  it("patch принимает все новые поля и null-удаление", () => {
    const patch = {
      api: "openai-completions", baseUrl: "http://localhost:4010/v1",
      thinkingLevelMap: { off: null, low: "low", high: "high" },
      samplingParams: { reasoning_effort: "high" },
      samplingParamsByThinkingLevel: { high: { reasoning_effort: "high" } },
      compat: { supportsDeveloperRole: false, supportsStore: false, promptCacheKeyMode: "disabled" },
      cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
      promptCache: { short: 300, long: 3600 },
      inputLimits: { maxRequestBytes: 10485760 },
      apiKey: "model-key", headers: { "X-Api-Key": "$KEY", "X-Del": "" },
    };
    expect(modelPatchSchema.parse(patch)).toEqual(patch);
    expect(modelPatchSchema.parse({ compat: null, apiKey: "", headers: null })).toEqual({ compat: null, apiKey: "", headers: null });
  });
  it("patch отклоняет неверные типы и неизвестные ключи", () => {
    expect(modelPatchSchema.safeParse({ api: "azure-openai-responses" }).success).toBe(false);
    expect(modelPatchSchema.safeParse({ baseUrl: "ftp://x" }).success).toBe(false);
    expect(modelPatchSchema.safeParse({ apiKey: null }).success).toBe(false);
    expect(modelPatchSchema.safeParse({ cost: { input: 1 } }).success).toBe(false);
    expect(modelPatchSchema.safeParse({ compat: { supportsStore: "false" } }).success).toBe(false);
    expect(modelPatchSchema.safeParse({ compat: { promptCacheKeyMode: "wrong" } }).success).toBe(false);
    expect(modelPatchSchema.safeParse({ headers: { "X": 1 } }).success).toBe(false);
    expect(modelPatchSchema.safeParse({ modelOverrides: {} }).success).toBe(false);
  });
  it("thinkingLevelMap: уровни string|null, неизвестные ключи сохраняются", () => {
    const value = { off: null, minimal: null, low: "low", xhigh: "xhigh", custom: "keep" };
    expect(thinkingLevelMapSchema.parse(value)).toEqual(value);
    expect(thinkingLevelMapSchema.safeParse({ low: 5 }).success).toBe(false);
    expect(thinkingLevelMapSchema.safeParse([]).success).toBe(false);
  });
  it("samplingParams: свободный объект, неизвестное сохраняется, массив отклоняется", () => {
    const value = { reasoning_effort: "high", temperature: 0.7, custom: { a: 1 } };
    expect(samplingParamsSchema.parse(value)).toEqual(value);
    expect(samplingParamsSchema.safeParse([1]).success).toBe(false);
    const byLevel = { high: { reasoning_effort: "high" }, custom: { x: 1 } };
    expect(samplingParamsByThinkingLevelSchema.parse(byLevel)).toEqual(byLevel);
    expect(samplingParamsByThinkingLevelSchema.safeParse({ high: "high" }).success).toBe(false);
  });
  it("compat: типизированное подмножество + passthrough", () => {
    const value = { supportsDeveloperRole: false, thinkingFormat: "openai", maxTokensField: "max_tokens", unknownFutureField: true };
    expect(compatSchema.parse(value)).toEqual(value);
    expect(compatSchema.safeParse({ thinkingFormat: "wrong" }).success).toBe(false);
    expect(compatSchema.safeParse({ supportsLongCacheRetention: "yes" }).success).toBe(false);
    expect(COMPAT_FIELDS["openai-completions"]).toContain("promptCacheKeyMode");
    expect(COMPAT_FIELDS["anthropic-messages"]).toContain("supportsTemperature");
    expect(COMPAT_FIELDS["google-generative-ai"]).toEqual([]);
  });
  it("cost: четыре обязательных числа, tiers, неотрицательность", () => {
    const value = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, tiers: [{ inputTokensAbove: 200000, input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }], custom: 1 };
    expect(costSchema.parse(value)).toEqual(value);
    expect(costSchema.safeParse({ input: 1, output: 5, cacheRead: 0.1 }).success).toBe(false);
    expect(costSchema.safeParse({ input: -1, output: 5, cacheRead: 0, cacheWrite: 0 }).success).toBe(false);
    expect(costSchema.safeParse({ input: 1, output: 5, cacheRead: 0, cacheWrite: 0, tiers: [{ inputTokensAbove: 1 }] }).success).toBe(false);
  });
  it("promptCache/inputLimits: числа, вложенность, passthrough", () => {
    expect(promptCacheSchema.parse({ short: 300, long: 3600, extra: 1 })).toEqual({ short: 300, long: 3600, extra: 1 });
    expect(promptCacheSchema.safeParse({ short: "300" }).success).toBe(false);
    const limits = { maxRequestBytes: 100, images: { resize: { maxWidth: 1024, jpegQuality: 80 }, maxPerMessage: 5 }, extra: true };
    expect(inputLimitsSchema.parse(limits)).toEqual(limits);
    expect(inputLimitsSchema.safeParse({ images: { maxPerMessage: 1.5 } }).success).toBe(false);
  });
  it("headers: строковые значения, пустой ключ отклоняется", () => {
    expect(headersPatchSchema.parse({ "X-A": "v", "X-B": "" })).toEqual({ "X-A": "v", "X-B": "" });
    expect(headersPatchSchema.safeParse({ "": "v" }).success).toBe(false);
    expect(headersPatchSchema.safeParse({ "X-A": null }).success).toBe(false);
  });
  it("parseJsonField: понятные ошибки по-русски", () => {
    const field = { ...MODEL_FIELDS.find((f) => f.key === "compat")!, schema: compatSchema };
    expect(parseJsonField(field, "{oops").ok).toBe(false);
    const bad = parseJsonField(field, '{"supportsStore": "false"}');
    expect(bad.ok).toBe(false);
    if (!bad.ok) { expect(bad.error).toContain("Совместимость"); expect(bad.error).toContain("supportsStore"); }
    expect(parseJsonField(field, '{"supportsStore": false}')).toEqual({ ok: true, value: { supportsStore: false } });
  });
});

describe("providerIdSchema", () => {
  it("только slug", () => {
    expect(providerIdSchema.safeParse("router-gpt").success).toBe(true);
    expect(providerIdSchema.safeParse("Router GPT").success).toBe(false);
    expect(providerIdSchema.safeParse("").success).toBe(false);
  });
});
