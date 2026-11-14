// «Api модели» — бэкенд: RPC над ~/.pi/agent/models.json pi.
// Ключи и адреса живут только в этом файле (вне репо); фронтенду apiKey не возвращается.
import { homedir } from "node:os";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { discoverModels, resolveApiKey, testModel } from "./lib/discover";
import {
  connectModel, deleteProvider, disconnectModel, listProviders,
  readModelsFile, resolveModelsPath, updateModel, upsertProvider, writeModelsFile, type ModelsFile,
} from "./lib/models-file";
import { apiTypeSchema, baseUrlSchema, modelIdSchema, modelPatchSchema, providerIdSchema } from "./lib/schema";
import { fetchUsageSummary, usageSummarySchema } from "./lib/usage";

const providerViewSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  baseUrl: z.string(),
  api: z.string(),
  apiKeySet: z.boolean(),
  models: z.array(z.looseObject({ id: z.string() })),
});

export const rpcContract = defineRpcContract({
  providers_list: { input: z.null(), output: z.object({ providers: z.array(providerViewSchema) }) },
  provider_save: {
    input: z.object({
      id: providerIdSchema,
      name: z.string().max(200).optional(),
      baseUrl: baseUrlSchema,
      api: apiTypeSchema,
      apiKey: z.string().max(500).optional(),
    }).strict(),
    output: providerViewSchema,
  },
  provider_delete: { input: z.object({ id: providerIdSchema }).strict(), output: z.object({ removed: z.boolean() }) },
  models_discover: { input: z.object({ providerId: providerIdSchema }).strict(), output: z.object({ models: z.array(z.string()) }) },
  model_connect: {
    input: z.object({ providerId: providerIdSchema, modelId: modelIdSchema }).strict(),
    output: z.object({ connected: z.boolean() }),
  },
  model_disconnect: {
    input: z.object({ providerId: providerIdSchema, modelId: modelIdSchema }).strict(),
    output: z.object({ removed: z.boolean() }),
  },
  model_update: {
    input: z.object({ providerId: providerIdSchema, modelId: modelIdSchema, patch: modelPatchSchema }).strict(),
    output: z.looseObject({ id: z.string() }),
  },
  model_test: {
    input: z.object({ providerId: providerIdSchema, modelId: modelIdSchema }).strict(),
    output: z.object({ ok: z.boolean(), latencyMs: z.number(), detail: z.string() }),
  },
  provider_usage: {
    input: z.object({ providerId: providerIdSchema }).strict(),
    output: usageSummarySchema,
  },
});

const CHANGED = "api-models-changed";

export default async function plugin(bb: BbPluginApi) {
  // Путь к файлу pi конфигурируется: Settings → Installed plugins → Api модели
  // или `bb plugin config clirelay-test set modelsPath <путь>`. Читается при
  // загрузке — после смены нужен `bb plugin reload clirelay-test`.
  const settings = bb.settings.define({
    modelsPath: { type: "string", label: "Путь к models.json pi (пусто = ~/.pi/agent/models.json)", default: "" },
  });
  const { modelsPath } = await settings.get();
  // PI_MODELS_PATH — тестовый шов, важнее настройки.
  const filePath = resolveModelsPath(process.env, modelsPath, homedir());

  // ponytail: внутрипроцессный lock (очередь промисов). Апгрейд при multi-process — файловые блокировки.
  let queue: Promise<unknown> = Promise.resolve();
  function mutate<T>(fn: (file: ModelsFile) => T): Promise<T> {
    const run = queue.then(async () => {
      const file = await readModelsFile(filePath);
      const result = fn(file);
      await writeModelsFile(filePath, file);
      bb.realtime.publish(CHANGED, {});
      return result;
    });
    queue = run.catch(() => undefined);
    return run;
  }

  bb.rpc.register(rpcContract, {
    providers_list: async () => ({ providers: listProviders(await readModelsFile(filePath)) }),
    provider_save: async (input) =>
      mutate((file) => {
        upsertProvider(file, input);
        return listProviders(file).find((view) => view.id === input.id)!;
      }),
    provider_delete: async ({ id }) => ({ removed: await mutate((file) => deleteProvider(file, id)) }),
    models_discover: async ({ providerId }) => {
      const file = await readModelsFile(filePath);
      const entry = file.providers[providerId];
      if (!entry) throw new Error(`Провайдер не найден: ${providerId}`);
      if (typeof entry.baseUrl !== "string" || !entry.baseUrl) throw new Error("у провайдера не задан baseUrl");
      return { models: await discoverModels(entry.baseUrl, resolveApiKey(entry.apiKey)) };
    },
    model_connect: async ({ providerId, modelId }) => ({ connected: await mutate((file) => connectModel(file, providerId, modelId)) }),
    model_disconnect: async ({ providerId, modelId }) => ({ removed: await mutate((file) => disconnectModel(file, providerId, modelId)) }),
    model_update: async ({ providerId, modelId, patch }) => mutate((file) => updateModel(file, providerId, modelId, patch)),
    model_test: async ({ providerId, modelId }) => {
      const file = await readModelsFile(filePath);
      const entry = file.providers[providerId];
      if (!entry) throw new Error(`Провайдер не найден: ${providerId}`);
      if (typeof entry.baseUrl !== "string" || !entry.baseUrl) throw new Error("у провайдера не задан baseUrl");
      const models = Array.isArray(entry.models) ? entry.models : [];
      const model = models.find((item) => item && typeof item === "object" && (item as Record<string, unknown>).id === modelId) as Record<string, unknown> | undefined;
      if (!model) throw new Error(`Модель не найдена: ${modelId}`);
      const api = typeof model.api === "string" ? model.api : entry.api;
      if (api !== "openai-completions") return { ok: false, latencyMs: 0, detail: "тест поддерживается только для openai-completions" };
      return testModel(entry.baseUrl, resolveApiKey(entry.apiKey), modelId);
    },
    provider_usage: async ({ providerId }) => {
      const file = await readModelsFile(filePath);
      const entry = file.providers[providerId];
      if (!entry) throw new Error(`Провайдер не найден: ${providerId}`);
      if (typeof entry.baseUrl !== "string" || !entry.baseUrl) throw new Error("у провайдера не задан baseUrl");
      return fetchUsageSummary(entry.baseUrl, resolveApiKey(entry.apiKey));
    },
  });

  bb.log.info("api-models loaded");
}
