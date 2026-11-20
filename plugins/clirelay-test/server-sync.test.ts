import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./server.js";

type Host = ReturnType<typeof createFakePluginHost>;
const hosts: Host[] = [];

const DONOR = {
  id: "gpt-6.2-sol",
  name: "GPT-6.2 Sol",
  apiKey: "donor-key",
  headers: { "X-Donor": "donor-secret" },
  contextWindow: 100,
  maxTokens: 50,
  reasoning: true,
  thinkingLevelMap: { low: "low", custom: "x" },
  compat: { supportsStore: true },
  cost: { input: 1, output: 0 },
  promptCache: { keyMode: "auto" },
  samplingParams: { temperature: 0 },
  inputLimits: { text: 10 },
  unknownField: "keep out",
};

const SETTINGS = {
  defaultModel: "p/gpt-6.2-sol",
  defaultProvider: "p",
  modelThinkingLevels: { "p/gpt-6.2-sol": "high" },
  enabledModels: ["p/gpt-6.2-sol", "wild/*", "other/x"],
  compaction: { modelOverrides: { "p/gpt-6.2-sol": { contextWindow: 123, nested: { a: [1] } } }, keep: 1 },
};

async function load(models: unknown[], extra: { settings?: unknown; disabled?: unknown[] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "api-models-sync-"));
  const path = join(dir, "models.json");
  const settingsPath = join(dir, "settings.json");
  const file = {
    providers: {
      p: { baseUrl: "http://localhost:4010/v1", api: "openai-completions", apiKey: "prov-key", models },
    },
  };
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`);
  if (extra.settings !== undefined) await writeFile(settingsPath, `${JSON.stringify(extra.settings, null, 2)}\n`);
  process.env.PI_MODELS_PATH = path;
  const host = createFakePluginHost({ pluginId: "clirelay-test" });
  await plugin(host.bb);
  if (extra.disabled) await host.bb.storage.kv.set("disabled-models:p", extra.disabled);
  hosts.push(host);
  return { host, path, settingsPath, dir };
}

function api(items: unknown[]) {
  const mock = vi.fn(async () => new Response(JSON.stringify({ data: items }), { status: 200 }));
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(async () => {
  delete process.env.PI_MODELS_PATH;
  vi.unstubAllGlobals();
  await Promise.all(hosts.splice(0).map((host) => host.harness.lifecycle.dispose()));
});

describe("models_sync_scan", () => {
  it("только новые id, donor-proposal, файл не меняется, секреты не утекают", async () => {
    const { host, path } = await load([DONOR]);
    const before = await readFile(path, "utf8");
    api([
      { id: "gpt-6.2-sol", context_window: 999 },
      { id: "gpt-7.1-sol", context_window: 200000, max_tokens: 8192, input_modalities: ["text", "image"], supported_reasoning_levels: ["off", "low"] },
      { id: "gpt-7.1-sol", context_window: 1 },
    ]);
    const result = await host.harness.behavior.callRpc("models_sync_scan", { providerId: "p" });
    expect(result).toEqual({
      models: [{
        id: "gpt-7.1-sol",
        contextWindow: 200000,
        maxTokens: 8192,
        input: ["text", "image"],
        supportedReasoningLevels: ["off", "low"],
        donor: { id: "gpt-6.2-sol", name: "GPT-6.2 Sol", enabled: true, contextWindow: 100, maxTokens: 50 },
        donorCandidates: [],
      }],
    });
    const payload = JSON.stringify(result);
    expect(payload).not.toContain("donor-key");
    expect(payload).not.toContain("donor-secret");
    expect(payload).not.toContain("keep out");
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("уже подключённые и выключенные модели не предлагаются; disabled-донор виден", async () => {
    const { host } = await load([DONOR], { disabled: [{ id: "gpt-v6.3.0-sol", enabled: undefined }] });
    api([{ id: "gpt-6.2-sol" }, { id: "gpt-6.3-sol" }, { id: "gpt-6.4-sol" }]);
    const result = (await host.harness.behavior.callRpc("models_sync_scan", { providerId: "p" })) as {
      models: Array<{ id: string; donor?: { id: string; enabled: boolean }; donorCandidates: Array<{ id: string; enabled: boolean }> }>;
    };
    // §3.1: новая = нет ни в models, ни в disabled. gpt-6.2-sol подключена → скрыта.
    expect(result.models.map((model) => model.id)).toEqual(["gpt-6.3-sol", "gpt-6.4-sol"]);
    // Единственный максимум версии 6.3 среди pool — выключенный донор.
    expect(result.models[1]!.donor).toEqual({ id: "gpt-v6.3.0-sol", enabled: false });
    expect(result.models[1]!.donorCandidates).toEqual([]);
  });

  it("равный максимум версии в pool → ambiguity, выбора нет", async () => {
    const { host } = await load([DONOR], { disabled: [{ id: "gpt-v6.3.0-sol" }, { id: "gpt-6.3.0-sol" }] });
    api([{ id: "gpt-6.4-sol" }]);
    const result = (await host.harness.behavior.callRpc("models_sync_scan", { providerId: "p" })) as {
      models: Array<{ id: string; donor?: { id: string }; donorCandidates: Array<{ id: string; enabled: boolean }> }>;
    };
    expect(result.models[0]!.donor).toBeUndefined();
    // §4.2.4: кандидаты — все подходящие более старые id, version desc + id asc
    expect(result.models[0]!.donorCandidates.map((entry) => [entry.id, entry.enabled])).toEqual([
      ["gpt-6.3.0-sol", false],
      ["gpt-v6.3.0-sol", false],
      ["gpt-6.2-sol", true],
    ]);
  });

  it("чужой provider → ошибка без запросов", async () => {
    const { host } = await load([]);
    await host.harness.behavior.callRpc("provider_save", { id: "q", baseUrl: "http://localhost:4010/v1", api: "openai-completions" });
    const mock = api([]);
    await expect(host.harness.behavior.callRpc("models_sync_scan", { providerId: "nope" })).rejects.toThrow(/не найден/);
    expect(mock).not.toHaveBeenCalled();
  });
});

describe("model_sync_apply", () => {
  it("клонирует donor server-side, пишет лимиты API и не трогает settings при replaceInPi:false", async () => {
    const { host, path, settingsPath } = await load([DONOR], { settings: SETTINGS });
    const settingsBefore = await readFile(settingsPath, "utf8");
    api([{ id: "gpt-7.1-sol", context_window: 200000, max_tokens: 8192, input_modalities: ["text", "image"], supported_reasoning_levels: ["off", "high"] }]);
    const result = await host.harness.behavior.callRpc("model_sync_apply", { providerId: "p", modelId: "gpt-7.1-sol", donorId: "gpt-6.2-sol", replaceInPi: false });
    expect(result).toEqual({
      status: "applied",
      modelAdded: true,
      settings: "skipped",
      sources: { contextWindow: "api", maxTokens: "api", input: "api" },
    });
    const file = JSON.parse(await readFile(path, "utf8")) as { providers: Record<string, { models: Array<Record<string, unknown>> }> };
    const models = file.providers.p!.models;
    expect(models[0]).toEqual(DONOR);
    const added = models[1]!;
    expect(added.id).toBe("gpt-7.1-sol");
    expect(added.apiKey).toBe("donor-key");
    expect(added.headers).toEqual({ "X-Donor": "donor-secret" });
    expect(added.contextWindow).toBe(200000);
    expect(added.maxTokens).toBe(8192);
    expect(added.input).toEqual(["text", "image"]);
    expect(added.reasoning).toBe(true);
    // §5.3: API-уровни ["off","high"] → low не поддержан → null; "high" без donor
    // mapping не выдумываем; неизвестный ключ donor сохраняется.
    expect(added.thinkingLevelMap).toEqual({ low: null, custom: "x", minimal: null, medium: null, xhigh: null, max: null });
    expect(added.cost).toEqual({ input: 1, output: 0 });
    expect(added.promptCache).toEqual({ keyMode: "auto" });
    expect(added.samplingParams).toEqual({ temperature: 0 });
    expect(added.inputLimits).toEqual({ text: 10 });
    expect(added).not.toHaveProperty("name");
    expect(added).not.toHaveProperty("unknownField");
    expect(await readFile(settingsPath, "utf8")).toBe(settingsBefore);
  });

  it("без надёжных API-значений берёт donor fallback и отдаёт sources", async () => {
    const { host, path } = await load([DONOR]);
    api([{ id: "gpt-7.1-sol", max_tokens: "8192" }]);
    const result = await host.harness.behavior.callRpc("model_sync_apply", { providerId: "p", modelId: "gpt-7.1-sol", donorId: "gpt-6.2-sol", replaceInPi: false });
    expect((result as { sources: unknown }).sources).toEqual({ contextWindow: "donor", maxTokens: "donor", input: "default" });
    const file = JSON.parse(await readFile(path, "utf8")) as { providers: Record<string, { models: Array<Record<string, unknown>> }> };
    const added = file.providers.p!.models[1]!;
    expect(added.contextWindow).toBe(100);
    expect(added.maxTokens).toBe(50);
    expect(added).not.toHaveProperty("input");
    // нет API-уровней → donor reasoning/map как есть
    expect(added.thinkingLevelMap).toEqual({ low: "low", custom: "x" });
  });

  it("replaceInPi:true заменяет exact donor и клонирует compaction, не трогая default*", async () => {
    const { host, path, settingsPath } = await load([DONOR], { settings: SETTINGS });
    api([{ id: "gpt-7.1-sol", context_window: 200000 }]);
    const result = await host.harness.behavior.callRpc("model_sync_apply", { providerId: "p", modelId: "gpt-7.1-sol", donorId: "gpt-6.2-sol", replaceInPi: true });
    expect(result).toEqual({ status: "applied", modelAdded: true, settings: "updated", sources: { contextWindow: "api", maxTokens: "donor", input: "default" } });
    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, any>;
    expect(settings.enabledModels).toEqual(["p/gpt-7.1-sol", "wild/*", "other/x"]);
    expect(settings.compaction.modelOverrides["p/gpt-6.2-sol"]).toEqual({ contextWindow: 123, nested: { a: [1] } });
    expect(settings.compaction.modelOverrides["p/gpt-7.1-sol"]).toEqual({ contextWindow: 123, nested: { a: [1] } });
    expect(settings.compaction.keep).toBe(1);
    expect(settings.defaultModel).toBe("p/gpt-6.2-sol");
    expect(settings.defaultProvider).toBe("p");
    expect(settings.modelThinkingLevels).toEqual({ "p/gpt-6.2-sol": "high" });
    expect(await readFile(`${settingsPath}.bak`, "utf8")).toBe(`${JSON.stringify(SETTINGS, null, 2)}\n`);
    const file = JSON.parse(await readFile(path, "utf8")) as { providers: Record<string, { models: Array<{ id: string }> }> };
    expect(file.providers.p!.models.map((model) => model.id)).toEqual(["gpt-6.2-sol", "gpt-7.1-sol"]);
  });

  it("битый settings.json → ошибка, models не записан, файлы не изменены", async () => {
    const { host, path, settingsPath } = await load([DONOR], { settings: { enabledModels: "p/gpt-6.2-sol" } });
    const modelsBefore = await readFile(path, "utf8");
    const settingsBefore = await readFile(settingsPath, "utf8");
    api([{ id: "gpt-7.1-sol" }]);
    await expect(host.harness.behavior.callRpc("model_sync_apply", { providerId: "p", modelId: "gpt-7.1-sol", donorId: "gpt-6.2-sol", replaceInPi: true })).rejects.toThrow(/settings\.json/);
    expect(await readFile(path, "utf8")).toBe(modelsBefore);
    expect(await readFile(settingsPath, "utf8")).toBe(settingsBefore);
  });

  it("модель исчезла из API и ещё не подключена → ошибка без записи", async () => {
    const { host, path } = await load([DONOR]);
    const before = await readFile(path, "utf8");
    api([{ id: "gpt-6.2-sol" }]);
    await expect(host.harness.behavior.callRpc("model_sync_apply", { providerId: "p", modelId: "gpt-7.1-sol", donorId: "gpt-6.2-sol", replaceInPi: false })).rejects.toThrow(/не найдена в API/);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("чужой donor отклоняется: только детерминированные кандидаты", async () => {
    const { host, path } = await load([DONOR, { id: "gpt-6.2-eco", apiKey: "eco-key" }]);
    const before = await readFile(path, "utf8");
    api([{ id: "gpt-7.1-sol" }]);
    await expect(host.harness.behavior.callRpc("model_sync_apply", { providerId: "p", modelId: "gpt-7.1-sol", donorId: "gpt-6.2-eco", replaceInPi: false })).rejects.toThrow(/донор/);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("models записан, settings-write упал → partial, повтор добирает settings без второго клона", async () => {
    const { host, path, settingsPath } = await load([DONOR], { settings: SETTINGS });
    api([{ id: "gpt-7.1-sol", context_window: 200000 }]);
    // .bak занят каталогом → copyFile падает уже после успешной записи models.
    const bak = `${settingsPath}.bak`;
    await mkdir(bak);
    const first = await host.harness.behavior.callRpc("model_sync_apply", { providerId: "p", modelId: "gpt-7.1-sol", donorId: "gpt-6.2-sol", replaceInPi: true });
    expect(first).toEqual({ status: "partial", modelAdded: true, settings: "failed", sources: { contextWindow: "api", maxTokens: "donor", input: "default" } });
    const modelsAfterFirst = await readFile(path, "utf8");
    expect((JSON.parse(modelsAfterFirst) as { providers: Record<string, { models: Array<{ id: string }> }> }).providers.p!.models.map((model) => model.id)).toEqual(["gpt-6.2-sol", "gpt-7.1-sol"]);
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual(SETTINGS);

    await rm(bak, { recursive: true, force: true });
    const second = await host.harness.behavior.callRpc("model_sync_apply", { providerId: "p", modelId: "gpt-7.1-sol", donorId: "gpt-6.2-sol", replaceInPi: true });
    expect(second).toEqual({ status: "noop", modelAdded: false, settings: "updated" });
    expect(await readFile(path, "utf8")).toBe(modelsAfterFirst); // второго клона нет
    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, any>;
    expect(settings.enabledModels).toEqual(["p/gpt-7.1-sol", "wild/*", "other/x"]);
    expect(settings.compaction.modelOverrides["p/gpt-7.1-sol"]).toEqual({ contextWindow: 123, nested: { a: [1] } });
  });

  it("вход строгий: клиентские metadata и секреты не принимаются", async () => {
    const { host, path } = await load([DONOR]);
    const before = await readFile(path, "utf8");
    api([{ id: "gpt-7.1-sol" }]);
    await expect(host.harness.behavior.callRpc("model_sync_apply", {
      providerId: "p", modelId: "gpt-7.1-sol", donorId: "gpt-6.2-sol", replaceInPi: false,
      contextWindow: 1, apiKey: "client-key",
    })).rejects.toThrow();
    await expect(host.harness.behavior.callRpc("models_sync_scan", { providerId: "p", modelId: "gpt-7.1-sol" })).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("выключенный донор клонируется и остаётся выключенным", async () => {
    const { host, path } = await load([DONOR], { disabled: [{ ...DONOR, id: "gpt-6.3-sol", name: "GPT-6.3 Sol" }] });
    api([{ id: "gpt-7.1-sol" }]);
    const result = await host.harness.behavior.callRpc("model_sync_apply", { providerId: "p", modelId: "gpt-7.1-sol", donorId: "gpt-6.3-sol", replaceInPi: false });
    expect((result as { status: string }).status).toBe("applied");
    const file = JSON.parse(await readFile(path, "utf8")) as { providers: Record<string, { models: Array<Record<string, unknown>> }> };
    expect(file.providers.p!.models.map((model) => model.id)).toEqual(["gpt-6.2-sol", "gpt-7.1-sol"]);
    expect(file.providers.p!.models[1]!.apiKey).toBe("donor-key");
    // выключенный донор не появился в models и не изменился в kv
    expect(file.providers.p!.models.some((model) => model.id === "gpt-6.3-sol")).toBe(false);
    const disabled = await host.bb.storage.kv.get<Array<Record<string, unknown>>>("disabled-models:p");
    expect(disabled).toEqual([{ ...DONOR, id: "gpt-6.3-sol", name: "GPT-6.3 Sol" }]);
  });

  it("ambiguous: ручной выбор кандидата разрешён, чужой variant — нет", async () => {
    const { host, path } = await load([
      { id: "gpt-6.2-sol", apiKey: "a-key", contextWindow: 111 },
      { id: "gpt-v6.2.0-sol", apiKey: "b-key", contextWindow: 222 },
      { id: "gpt-6.0-eco", apiKey: "eco-key" },
    ]);
    api([{ id: "gpt-7.1-sol" }]);
    await expect(host.harness.behavior.callRpc("model_sync_apply", { providerId: "p", modelId: "gpt-7.1-sol", donorId: "gpt-6.0-eco", replaceInPi: false })).rejects.toThrow(/донор/);
    const result = await host.harness.behavior.callRpc("model_sync_apply", { providerId: "p", modelId: "gpt-7.1-sol", donorId: "gpt-v6.2.0-sol", replaceInPi: false });
    expect((result as { status: string }).status).toBe("applied");
    const file = JSON.parse(await readFile(path, "utf8")) as { providers: Record<string, { models: Array<Record<string, unknown>> }> };
    const added = file.providers.p!.models.find((model) => model.id === "gpt-7.1-sol")!;
    expect(added.apiKey).toBe("b-key");
    expect(added.contextWindow).toBe(222);
  });

  it("дубликат id в pool не выбирается молча даже вручную", async () => {
    const { host, path } = await load([{ id: "gpt-6.2-sol", apiKey: "a-key" }], { disabled: [{ id: "gpt-6.2-sol", apiKey: "b-key" }] });
    const before = await readFile(path, "utf8");
    api([{ id: "gpt-7.1-sol" }]);
    await expect(host.harness.behavior.callRpc("model_sync_apply", { providerId: "p", modelId: "gpt-7.1-sol", donorId: "gpt-6.2-sol", replaceInPi: false })).rejects.toThrow(/донор/);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("повтор идемпотентен: modelAdded:false, без дубликатов и перезаписи", async () => {
    const { host, path, settingsPath } = await load([DONOR], { settings: SETTINGS });
    api([{ id: "gpt-7.1-sol", context_window: 200000 }]);
    await host.harness.behavior.callRpc("model_sync_apply", { providerId: "p", modelId: "gpt-7.1-sol", donorId: "gpt-6.2-sol", replaceInPi: false });
    const modelsOnce = await readFile(path, "utf8");
    const second = await host.harness.behavior.callRpc("model_sync_apply", { providerId: "p", modelId: "gpt-7.1-sol", donorId: "gpt-6.2-sol", replaceInPi: false });
    expect(second).toEqual({ status: "noop", modelAdded: false, settings: "skipped" });
    expect(await readFile(path, "utf8")).toBe(modelsOnce);

    const third = await host.harness.behavior.callRpc("model_sync_apply", { providerId: "p", modelId: "gpt-7.1-sol", donorId: "gpt-6.2-sol", replaceInPi: true });
    expect(third).toEqual({ status: "noop", modelAdded: false, settings: "updated" });
    const fourth = await host.harness.behavior.callRpc("model_sync_apply", { providerId: "p", modelId: "gpt-7.1-sol", donorId: "gpt-6.2-sol", replaceInPi: true });
    expect(fourth).toEqual({ status: "noop", modelAdded: false, settings: "unchanged" });
    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, any>;
    expect(settings.enabledModels).toEqual(["p/gpt-7.1-sol", "wild/*", "other/x"]);
  });
});
