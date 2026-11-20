import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyModelPatch, connectModel, deleteProvider, disconnectModel, listProviders, mergeHeaders, modelView,
  readModelsFile, resolveModelsPath, updateModel, upsertProvider, writeModelsFile, type ModelEntry, type ModelsFile,
} from "./models-file";

const FIXTURE = {
  providers: {
    "router-test": {
      baseUrl: "http://localhost:4010/v1", api: "openai-completions", apiKey: "test-key",
      custom: { keep: true },
      models: [{ id: "m1", contextWindow: 1000, compat: { supportsStore: false } }],
    },
  },
  topLevel: true,
};

async function fixture(): Promise<{ path: string; file: ModelsFile }> {
  const dir = await mkdtemp(join(tmpdir(), "api-models-"));
  const path = join(dir, "models.json");
  await writeFile(path, JSON.stringify(FIXTURE));
  return { path, file: await readModelsFile(path) };
}

describe("resolveModelsPath", () => {
  it("env важнее настройки и дефолта", () => {
    expect(resolveModelsPath({ PI_MODELS_PATH: "/tmp/env.json" }, "/tmp/cfg.json", "/home/u")).toBe("/tmp/env.json");
  });
  it("настройка важнее дефолта, пробелы тримятся", () => {
    expect(resolveModelsPath({}, " /tmp/cfg.json ", "/home/u")).toBe("/tmp/cfg.json");
  });
  it("дефолт ~/.pi/agent/models.json", () => {
    expect(resolveModelsPath({}, "", "/home/u")).toBe("/home/u/.pi/agent/models.json");
    expect(resolveModelsPath({}, undefined, "/home/u")).toBe("/home/u/.pi/agent/models.json");
  });
});

describe("readModelsFile", () => {
  it("нет файла → пустой providers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "api-models-"));
    expect(await readModelsFile(join(dir, "missing.json"))).toEqual({ providers: {} });
  });
  it("битый JSON → ошибка", async () => {
    const dir = await mkdtemp(join(tmpdir(), "api-models-"));
    const path = join(dir, "models.json");
    await writeFile(path, "{oops");
    await expect(readModelsFile(path)).rejects.toThrow(/повреждён/);
  });
});

describe("writeModelsFile", () => {
  it("атомарная запись + .bak с прежним содержимым", async () => {
    const { path, file } = await fixture();
    file.providers["router-test"]!.baseUrl = "http://localhost:4011/v1";
    await writeModelsFile(path, file);
    expect(JSON.parse(await readFile(path, "utf8")).providers["router-test"].baseUrl).toBe("http://localhost:4011/v1");
    expect(JSON.parse(await readFile(`${path}.bak`, "utf8")).providers["router-test"].baseUrl).toBe("http://localhost:4010/v1");
  });
});

describe("мутации", () => {
  it("upsert сохраняет неизвестные поля и ключ при пустом apiKey", async () => {
    const { file } = await fixture();
    upsertProvider(file, { id: "router-test", baseUrl: "http://localhost:4011/v1", api: "openai-completions" });
    const entry = file.providers["router-test"]!;
    expect(entry.apiKey).toBe("test-key");
    expect(entry.custom).toEqual({ keep: true });
    expect(file.topLevel).toBe(true);
  });
  it("connect пишет только id, повтор → false", async () => {
    const { file } = await fixture();
    expect(connectModel(file, "router-test", "m2")).toBe(true);
    expect(connectModel(file, "router-test", "m2")).toBe(false);
    expect(file.providers["router-test"]!.models).toEqual([
      { id: "m1", contextWindow: 1000, compat: { supportsStore: false } }, { id: "m2" },
    ]);
  });
  it("disconnect удаляет, отсутствующая → false", async () => {
    const { file } = await fixture();
    expect(disconnectModel(file, "router-test", "m1")).toBe(true);
    expect(disconnectModel(file, "router-test", "m1")).toBe(false);
  });
  it("update: null удаляет поле, неизвестные поля модели целы", async () => {
    const { file } = await fixture();
    const model = updateModel(file, "router-test", "m1", { contextWindow: null, reasoning: true });
    expect(model).toEqual({ id: "m1", compat: { supportsStore: false }, reasoning: true });
  });
  it("deleteProvider", async () => {
    const { file } = await fixture();
    expect(deleteProvider(file, "router-test")).toBe(true);
    expect(deleteProvider(file, "router-test")).toBe(false);
  });
  it("listProviders не отдаёт apiKey и headers", async () => {
    const { file } = await fixture();
    file.providers["router-test"]!.headers = { "X-Secret": "test-key" };
    const [view] = listProviders(file);
    expect(view).toMatchObject({
      id: "router-test", baseUrl: "http://localhost:4010/v1",
      api: "openai-completions", apiKeySet: true,
      headersSet: true, headerNames: ["X-Secret"],
      models: [{ id: "m1", contextWindow: 1000, compat: { supportsStore: false }, apiKeySet: false, headersSet: false, headerNames: [] }],
      disabled: [],
    });
    expect(JSON.stringify(view)).not.toContain("test-key");
  });
});

describe("API-патч модели", () => {
  it("apiKey: установка, очистка пустой строкой, отсутствие не трогает", () => {
    const model: ModelEntry = { id: "m1", apiKey: "old-key" };
    applyModelPatch(model, {});
    expect(model.apiKey).toBe("old-key");
    applyModelPatch(model, { apiKey: "new-key" });
    expect(model.apiKey).toBe("new-key");
    applyModelPatch(model, { apiKey: "" });
    expect(model.apiKey).toBeUndefined();
  });
  it("headers: мерж по ключам, \"\" удаляет ключ, пустой результат удаляет поле, null удаляет всё", () => {
    const model: ModelEntry = { id: "m1", headers: { "X-Keep": "secret-1", "X-Del": "secret-2" } };
    applyModelPatch(model, { headers: { "X-New": "$ENV", "X-Del": "" } });
    expect(model.headers).toEqual({ "X-Keep": "secret-1", "X-New": "$ENV" });
    applyModelPatch(model, { headers: { "X-Keep": "", "X-New": "" } });
    expect(model.headers).toBeUndefined();
    applyModelPatch(model, { headers: { "X-A": "v" } });
    applyModelPatch(model, { headers: null });
    expect(model.headers).toBeUndefined();
  });
  it("JSON-поля заменяются, неизвестные поля модели целы, null удаляет", () => {
    const model: ModelEntry = { id: "m1", custom: { keep: true }, compat: { supportsStore: false }, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } };
    applyModelPatch(model, { compat: { supportsDeveloperRole: false }, samplingParams: { reasoning_effort: "high" }, cost: null });
    expect(model).toEqual({ id: "m1", custom: { keep: true }, compat: { supportsDeveloperRole: false }, samplingParams: { reasoning_effort: "high" } });
  });
  it("mergeHeaders: не-объект current игнорируется, пустой патч сохраняет", () => {
    expect(mergeHeaders("junk", { "X": "v" })).toEqual({ "X": "v" });
    expect(mergeHeaders({ "X": "v" }, {})).toEqual({ "X": "v" });
    expect(mergeHeaders(undefined, {})).toBeNull();
  });
  it("modelView: секреты не утекают, флаги и имена на месте", () => {
    const view = modelView({ id: "m1", apiKey: "model-key", headers: { "X-Secret": "header-secret" }, reasoning: true });
    expect(view).toEqual({ id: "m1", reasoning: true, apiKeySet: true, headersSet: true, headerNames: ["X-Secret"] });
    expect(JSON.stringify(view)).not.toContain("model-key");
    expect(JSON.stringify(view)).not.toContain("header-secret");
    expect(modelView({ id: "m2" })).toEqual({ id: "m2", apiKeySet: false, headersSet: false, headerNames: [] });
  });
  it("updateModel использует applyModelPatch (секретная семантика)", () => {
    const file: ModelsFile = { providers: { p: { models: [{ id: "m1", apiKey: "old", headers: { "X": "v" } }] } } };
    updateModel(file, "p", "m1", { apiKey: "", headers: { "X": "" } });
    expect(file.providers.p!.models).toEqual([{ id: "m1" }]);
  });
});

describe("провайдер: API-поля", () => {
  it("upsert: authHeader/oauth/compat set, null удаляет, отсутствие не трогает; headers мерж", async () => {
    const { file } = await fixture();
    upsertProvider(file, { id: "router-test", baseUrl: "http://localhost:4010/v1", api: "openai-completions", authHeader: true, oauth: "radius", compat: { supportsStore: false }, headers: { "X-P": "prov-secret" } });
    const entry = file.providers["router-test"]!;
    expect(entry.authHeader).toBe(true);
    expect(entry.oauth).toBe("radius");
    expect(entry.compat).toEqual({ supportsStore: false });
    expect(entry.headers).toEqual({ "X-P": "prov-secret" });
    upsertProvider(file, { id: "router-test", baseUrl: "http://localhost:4010/v1", api: "openai-completions", headers: { "X-Q": "v2" } });
    expect(file.providers["router-test"]!.headers).toEqual({ "X-P": "prov-secret", "X-Q": "v2" });
    expect(file.providers["router-test"]!.authHeader).toBe(true);
    upsertProvider(file, { id: "router-test", baseUrl: "http://localhost:4010/v1", api: "openai-completions", authHeader: null, oauth: null, compat: null, headers: null });
    const cleared = file.providers["router-test"]!;
    expect(cleared.authHeader).toBeUndefined();
    expect(cleared.oauth).toBeUndefined();
    expect(cleared.compat).toBeUndefined();
    expect(cleared.headers).toBeUndefined();
    expect(cleared.apiKey).toBe("test-key"); // прежняя семантика ключа провайдера не меняется
    expect(cleared.custom).toEqual({ keep: true });
  });
  it("listProviders: провайдерские флаги/compat видны, секреты моделей и провайдера — нет", async () => {
    const { file } = await fixture();
    file.providers["router-test"]!.headers = { "X-Secret": "prov-secret" };
    file.providers["router-test"]!.authHeader = true;
    file.providers["router-test"]!.compat = { supportsStore: false };
    (file.providers["router-test"]!.models as ModelEntry[])[0]!.apiKey = "model-key";
    (file.providers["router-test"]!.models as ModelEntry[])[0]!.headers = { "X-M": "model-secret" };
    const [view] = listProviders(file);
    expect(view!.authHeader).toBe(true);
    expect(view!.compat).toEqual({ supportsStore: false });
    expect(view!.headersSet).toBe(true);
    expect(view!.headerNames).toEqual(["X-Secret"]);
    expect(view!.models[0]).toMatchObject({ id: "m1", apiKeySet: true, headersSet: true, headerNames: ["X-M"] });
    const dump = JSON.stringify(view);
    for (const secret of ["test-key", "prov-secret", "model-key", "model-secret"]) expect(dump).not.toContain(secret);
  });
});
