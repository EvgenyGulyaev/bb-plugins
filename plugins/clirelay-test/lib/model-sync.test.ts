import { describe, expect, it } from "vitest";
import type { ModelEntry } from "./models-file";
import {
  cloneDonorEntry,
  DONOR_FIELDS,
  effectiveInput,
  effectiveLimit,
  effectiveReasoning,
  effectiveView,
  matchDonor,
  parseModelId,
} from "./model-sync";

describe("parseModelId", () => {
  it("таблица §4.1", () => {
    expect(parseModelId("gpt-6.2-sol")).toEqual({ family: "gpt", version: [6, 2], variant: "sol" });
    expect(parseModelId("deepseek-v4.1-flash")).toEqual({ family: "deepseek", version: [4, 1], variant: "flash" });
    expect(parseModelId("deepseek-v4.1-1017")).toEqual({ family: "deepseek", version: [4, 1], variant: "1017" });
    expect(parseModelId("claude-opus-5-5")).toEqual({ family: "claude-opus", version: [5, 5], variant: "" });
    expect(parseModelId("claude-fable-5-1:batch")).toEqual({ family: "claude-fable", version: [5, 1], variant: ":batch" });
  });
  it("unversioned и регистр", () => {
    expect(parseModelId("custom")).toBeNull();
    expect(parseModelId("GPT-6.2-SOL")).toEqual({ family: "gpt", version: [6, 2], variant: "sol" });
  });
  it("первая версия: хвост после v4.1 не склеивается", () => {
    expect(parseModelId("deepseek-v4.1-1017")).toEqual({ family: "deepseek", version: [4, 1], variant: "1017" });
    expect(parseModelId("gpt-v6.2.0-sol")).toEqual({ family: "gpt", version: [6, 2, 0], variant: "sol" });
  });
});

const pool = (...ids: string[]) => ids.map((id) => ({ id, enabled: true }));

describe("matchDonor — таблица §4.2", () => {
  const cases: Array<[string[], string, string | null]> = [
    [["gpt-6.2-sol"], "gpt-7.1-sol", "gpt-6.2-sol"],
    [["gpt-6.2-sol", "gpt-6.1-sol"], "gpt-7.1-sol", "gpt-6.2-sol"],
    [["gpt-6.2-sol"], "gpt-7.1-eco", null],
    [["gpt-6.2-sol"], "gpt-7.1", null],
    [["gpt-7.1-sol"], "gpt-6.2-sol", null],
    [["gpt-7.1-sol", "gpt-6.0-sol"], "gpt-6.2-sol", null],
    [["deepseek-v4.1-flash"], "deepseek-v4.2-eco", null],
    [["deepseek-v4.1-1017"], "deepseek-v4.2", null],
    [["deepseek-v4.1"], "deepseek-v4.2-1017", null],
    [["deepseek-v4.1-1017"], "deepseek-v4.2-1017", "deepseek-v4.1-1017"],
    [["claude-opus-5-5"], "claude-opus-6-0", "claude-opus-5-5"],
    [["claude-fable-5-1"], "claude-fable-5-2:batch", null],
    [["claude-fable-5-1:batch"], "claude-fable-5-2:batch", "claude-fable-5-1:batch"],
    [["custom"], "custom-new", null],
  ];
  for (const [existing, next, expected] of cases) {
    it(`${existing.join(", ")} → ${next} = ${expected ?? "no donor"}`, () => {
      const result = matchDonor(next, pool(...existing));
      expect(result.donor).toBe(expected);
      // §7: donor и непустой candidates взаимоисключающи
      expect(result.candidates).toEqual([]);
    });
  }
  it("равный максимум разных id → ambiguous без выбора, candidates в порядке version desc/id asc", () => {
    const result = matchDonor("gpt-7-sol", pool("gpt-6.2-sol", "gpt-v6.2.0-sol"));
    expect(result.donor).toBeNull();
    expect(result.candidates.map((entry) => entry.id)).toEqual(["gpt-6.2-sol", "gpt-v6.2.0-sol"]);
  });
  it("причина ambiguity различает tie и duplicate (§4.2): ручной выбор только при tie", () => {
    expect(matchDonor("gpt-7-sol", pool("gpt-6.2-sol", "gpt-v6.2.0-sol")).ambiguous).toBe("tie");
    expect(matchDonor("gpt-7.1-sol", [...pool("gpt-6.2-sol"), { id: "gpt-6.2-sol", enabled: false }]).ambiguous).toBe("duplicate");
    expect(matchDonor("gpt-7.1-sol", pool("gpt-6.2-sol")).ambiguous).toBeUndefined();
  });
  it("ambiguous candidates включают все подходящие более старые версии", () => {
    const result = matchDonor("gpt-9-sol", pool("gpt-6.2-sol", "gpt-v6.2.0-sol", "gpt-5.0-sol"));
    expect(result.donor).toBeNull();
    expect(result.candidates.map((entry) => entry.id)).toEqual(["gpt-6.2-sol", "gpt-v6.2.0-sol", "gpt-5.0-sol"]);
  });
  it("дубликат id в pool не выбирается молча", () => {
    const result = matchDonor("gpt-7.1-sol", [...pool("gpt-6.2-sol"), { id: "gpt-6.2-sol", enabled: false }]);
    expect(result.donor).toBeNull();
    expect(result.candidates.map((entry) => entry.id)).toEqual(["gpt-6.2-sol"]);
  });
  it("disabled-донор матчится и помечен enabled:false", () => {
    const result = matchDonor("gpt-7.1-sol", [{ id: "gpt-6.2-sol", enabled: false }]);
    expect(result).toEqual({ donor: "gpt-6.2-sol", candidates: [] });
  });
  it("неверсионированный новый id → no donor", () => {
    expect(matchDonor("custom-new", pool("custom"))).toEqual({ donor: null, candidates: [] });
  });
});

const donor: ModelEntry = {
  id: "gpt-6.2-sol",
  name: "Sol",
  api: "openai-completions",
  baseUrl: "http://localhost:4010/v1",
  apiKey: "donor-key",
  headers: { "X-Donor": "donor-secret" },
  reasoning: false,
  thinkingLevelMap: { off: null, low: "low" },
  input: ["text", "image"],
  samplingParams: { reasoning_effort: "high" },
  samplingParamsByThinkingLevel: { high: { reasoning_effort: "high" } },
  compat: { supportsStore: false },
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, tiers: [] },
  promptCache: { enabled: false },
  inputLimits: { text: 100 },
  contextWindow: 200000,
  maxTokens: 8192,
  unknownField: "keep out",
};

describe("cloneDonorEntry", () => {
  it("копирует только whitelist, без id/name/неизвестных полей", () => {
    const entry = cloneDonorEntry(donor, "gpt-7.1-sol");
    expect(entry.id).toBe("gpt-7.1-sol");
    expect(Object.keys(entry).sort()).toEqual(["api", "apiKey", "baseUrl", "compat", "cost", "headers", "id", "input", "inputLimits", "promptCache", "reasoning", "samplingParams", "samplingParamsByThinkingLevel", "thinkingLevelMap"].sort());
    for (const field of DONOR_FIELDS) expect(entry).toHaveProperty(field.split(".")[0]!);
    expect(entry).not.toHaveProperty("name");
    expect(entry).not.toHaveProperty("unknownField");
  });
  it("глубокий клон: мутация копии не трогает donor", () => {
    const entry = cloneDonorEntry(donor, "gpt-7.1-sol");
    (entry.headers as Record<string, string>)["X-Donor"] = "changed";
    (entry.cost as Record<string, unknown>).input = 99;
    (entry.thinkingLevelMap as Record<string, unknown>).low = "high";
    expect(donor.headers).toEqual({ "X-Donor": "donor-secret" });
    expect((donor.cost as Record<string, unknown>).input).toBe(1);
    expect(donor.thinkingLevelMap).toEqual({ off: null, low: "low" });
  });
  it("сохраняет false, 0 и null; не создаёт top-level null/undefined", () => {
    const entry = cloneDonorEntry(
      { id: "d", reasoning: false, compat: { supportsStore: false }, cost: { input: 0 }, thinkingLevelMap: { off: null, high: null }, promptCache: null, samplingParams: null, inputLimits: null },
      "n",
    );
    expect(entry.reasoning).toBe(false);
    expect(entry.compat).toEqual({ supportsStore: false });
    expect(entry.cost).toEqual({ input: 0 });
    expect(entry.thinkingLevelMap).toEqual({ off: null, high: null });
    expect(entry).not.toHaveProperty("promptCache");
    expect(entry).not.toHaveProperty("samplingParams");
    expect(entry).not.toHaveProperty("inputLimits");
  });
  it("пустой apiKey и не-object/пустые headers не копируются", () => {
    const entry = cloneDonorEntry({ id: "d", apiKey: "", headers: {}, api: "", baseUrl: "" }, "n");
    expect(entry).toEqual({ id: "n" });
    expect(cloneDonorEntry({ id: "d", headers: ["x"] }, "n")).toEqual({ id: "n" });
  });
});

describe("effectiveLimit", () => {
  it("API надёжен → api, иначе donor, иначе default", () => {
    expect(effectiveLimit(200000, donor, "contextWindow")).toEqual({ value: 200000, source: "api" });
    expect(effectiveLimit(undefined, donor, "contextWindow")).toEqual({ value: 200000, source: "donor" });
    expect(effectiveLimit(undefined, undefined, "contextWindow")).toEqual({ source: "default" });
  });
  it("donor fallback без API upper bound, но только positive safe integer", () => {
    expect(effectiveLimit(undefined, { id: "d", maxTokens: 2_000_000 }, "maxTokens")).toEqual({ value: 2_000_000, source: "donor" });
    for (const bad of [0, -1, 1.5, "8192", null]) {
      expect(effectiveLimit(undefined, { id: "d", maxTokens: bad as never }, "maxTokens")).toEqual({ source: "default" });
    }
  });
});

describe("effectiveInput", () => {
  it("api → donor → default", () => {
    expect(effectiveInput(["image"], donor)).toEqual({ value: ["image"], source: "api" });
    expect(effectiveInput(undefined, donor)).toEqual({ value: ["text", "image"], source: "donor" });
    expect(effectiveInput(undefined, { id: "d", input: ["audio"] })).toEqual({ source: "default" });
    expect(effectiveInput(undefined, undefined)).toEqual({ source: "default" });
  });
});

describe("effectiveReasoning", () => {
  it("нет уровней API → donor reasoning и thinkingLevelMap как есть", () => {
    expect(effectiveReasoning(undefined, donor)).toEqual({ reasoning: false, thinkingLevelMap: { off: null, low: "low" } });
  });
  it("все уровни off → reasoning false, off остаётся доступным", () => {
    const result = effectiveReasoning(["off"], donor);
    expect(result.reasoning).toBe(false);
    expect(result.thinkingLevelMap).toEqual({ off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null });
  });
  it("поддерживаемые уровни сохраняют donor mapping, неподдерживаемые → null, неизвестные ключи сохраняются", () => {
    const result = effectiveReasoning(["off", "high", "medium"], { id: "d", thinkingLevelMap: { low: "low", high: "high", custom: "x" } });
    expect(result.reasoning).toBe(true);
    expect(result.thinkingLevelMap!.high).toBe("high");
    expect(result.thinkingLevelMap!.low).toBeNull();
    expect(result.thinkingLevelMap!.custom).toBe("x");
    expect(result.thinkingLevelMap).not.toHaveProperty("medium"); // supported без donor mapping — не выдумываем
  });
  it("пустой массив → reasoning false", () => {
    expect(effectiveReasoning([], donor).reasoning).toBe(false);
  });
});

describe("effectiveView — итоговые значения для диалога §3.3", () => {
  it("API → donor → pi default с явной пометкой источника", () => {
    const apiModel = effectiveView({ contextWindow: 200000, maxTokens: 8192, input: ["text", "image"] });
    expect(apiModel).toEqual({
      contextWindow: { value: 200000, source: "api", label: "API" },
      maxTokens: { value: 8192, source: "api", label: "API" },
      input: { value: ["text", "image"], source: "api", label: "API" },
    });
    const donorModel = effectiveView({ donor: { contextWindow: 100, maxTokens: 50, input: ["text"] } });
    expect(donorModel.contextWindow).toEqual({ value: 100, source: "donor", label: "donor fallback" });
    expect(donorModel.input).toEqual({ value: ["text"], source: "donor", label: "donor fallback" });
    const defaults = effectiveView({});
    expect(defaults).toEqual({
      contextWindow: { value: 128000, source: "default", label: "pi default" },
      maxTokens: { value: 16384, source: "default", label: "pi default" },
      input: { value: ["text"], source: "default", label: "pi default" },
    });
  });
  it("невалидные API-значения не показываются как API", () => {
    const view = effectiveView({ contextWindow: 0, maxTokens: 1.5, input: ["audio"] as never, donor: { maxTokens: 50 } });
    expect(view.contextWindow.source).toBe("default");
    expect(view.maxTokens).toEqual({ value: 50, source: "donor", label: "donor fallback" });
    expect(view.input.source).toBe("default");
  });
});
