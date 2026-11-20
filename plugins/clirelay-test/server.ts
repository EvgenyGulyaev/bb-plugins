// «Api модели» — бэкенд: RPC над ~/.pi/agent/models.json pi.
// Ключи и адреса живут только в этом файле (вне репо); фронтенду apiKey не возвращается.
import { homedir } from "node:os";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { discoverModelDetails, discoverModels, resolveApiKey, testModel, type DiscoveredModel } from "./lib/discover";
import {
  addModelEntry, applyModelPatch, connectModel, deleteProvider, disconnectModel, hasModel, listProviders,
  modelView, readModelsFile, removeModelEntry, resolveModelsPath, updateModel, upsertProvider, writeModelsFile,
  type ModelEntry, type ModelsFile,
} from "./lib/models-file";
import {
  cloneDonorEntry, effectiveInput, effectiveLimit, effectiveReasoning, inputModalities, matchDonor,
  type InputModality,
} from "./lib/model-sync";
import {
  patchSettings, readSettingsFile, resolveSettingsPath, validateSettings, writeSettingsFile, type SyncKeys,
} from "./lib/settings-file";
import { apiTypeSchema, baseUrlSchema, compatSchema, headersPatchSchema, modelIdSchema, modelPatchSchema, providerIdSchema } from "./lib/schema";
import { fetchAuthFileStates, fetchRelayAccounts, relayAccountSchema, relayOrigin, setAuthFileDisabled } from "./lib/relay-accounts";
import { getManagementToken, loginRelay, type RelaySession } from "./lib/relay-auth";
import {
  RINGS_CHANGED,
  RINGS_KV_KEY,
  clampRingPerRow,
  clampRingSize,
  normalizeRingsState,
  ringsPerRowInputSchema,
  ringsSizeInputSchema,
  ringsStateSchema,
  ringsToggleInputSchema,
  type RingsState,
} from "./lib/rings";

const providerViewSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  baseUrl: z.string(),
  api: z.string(),
  apiKeySet: z.boolean(),
  authHeader: z.boolean().optional(),
  oauth: z.string().optional(),
  compat: z.looseObject({}).optional(),
  headersSet: z.boolean(),
  headerNames: z.array(z.string()),
  models: z.array(z.looseObject({ id: z.string() })),
  disabled: z.array(z.looseObject({ id: z.string() })),
});

const syncLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const modalitySchema = z.enum(["text", "image"]);
const donorViewSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  enabled: z.boolean(),
  contextWindow: z.number().optional(),
  maxTokens: z.number().optional(),
  input: z.array(modalitySchema).optional(),
});
const syncModelViewSchema = z.object({
  id: z.string(),
  contextWindow: z.number().optional(),
  maxTokens: z.number().optional(),
  input: z.array(modalitySchema).optional(),
  supportedReasoningLevels: z.array(syncLevelSchema).optional(),
  donor: donorViewSchema.optional(),
  donorCandidates: z.array(donorViewSchema),
});
const syncSourcesSchema = z.object({
  contextWindow: z.enum(["api", "donor", "default"]),
  maxTokens: z.enum(["api", "donor", "default"]),
  input: z.enum(["api", "donor", "default"]),
});
const syncApplyOutputSchema = z.object({
  status: z.enum(["applied", "partial", "noop"]),
  modelAdded: z.boolean(),
  settings: z.enum(["skipped", "updated", "unchanged", "failed"]),
  sources: syncSourcesSchema.optional(),
});

// Типы для фронта (import type — во фронт-бандл не попадает).
export type DonorView = z.infer<typeof donorViewSchema>;
export type SyncModelView = z.infer<typeof syncModelViewSchema>;

export const rpcContract = defineRpcContract({
  providers_list: { input: z.null(), output: z.object({ providers: z.array(providerViewSchema) }) },
  provider_save: {
    input: z.object({
      id: providerIdSchema,
      name: z.string().max(200).optional(),
      baseUrl: baseUrlSchema,
      api: apiTypeSchema,
      apiKey: z.string().max(500).optional(),
      authHeader: z.boolean().nullable().optional(),
      oauth: z.enum(["radius"]).nullable().optional(),
      compat: compatSchema.nullable().optional(),
      headers: headersPatchSchema.nullable().optional(),
    }).strict(),
    output: providerViewSchema,
  },
  provider_delete: { input: z.object({ id: providerIdSchema }).strict(), output: z.object({ removed: z.boolean() }) },
  models_discover: { input: z.object({ providerId: providerIdSchema }).strict(), output: z.object({ models: z.array(z.string()) }) },
  model_connect: {
    input: z.object({ providerId: providerIdSchema, modelId: modelIdSchema }).strict(),
    output: z.object({ connected: z.boolean() }),
  },
  models_sync_scan: {
    input: z.object({ providerId: providerIdSchema }).strict(),
    output: z.object({ models: z.array(syncModelViewSchema) }),
  },
  model_sync_apply: {
    input: z.object({
      providerId: providerIdSchema,
      modelId: modelIdSchema,
      donorId: modelIdSchema,
      replaceInPi: z.boolean(),
    }).strict(),
    output: syncApplyOutputSchema,
  },
  model_disconnect: {
    input: z.object({ providerId: providerIdSchema, modelId: modelIdSchema }).strict(),
    output: z.object({ removed: z.boolean() }),
  },
  model_toggle: {
    input: z.object({ providerId: providerIdSchema, modelId: modelIdSchema, enabled: z.boolean() }).strict(),
    output: z.object({ enabled: z.boolean() }),
  },
  model_update: {
    input: z.object({ providerId: providerIdSchema, modelId: modelIdSchema, patch: modelPatchSchema }).strict(),
    output: z.looseObject({ id: z.string() }),
  },
  model_test: {
    input: z.object({ providerId: providerIdSchema, modelId: modelIdSchema }).strict(),
    output: z.object({ ok: z.boolean(), latencyMs: z.number(), detail: z.string() }),
  },
  relay_accounts: {
    input: z.object({ providerId: providerIdSchema }).strict(),
    output: z.object({
      configured: z.boolean(),
      items: z.array(relayAccountSchema),
      error: z.string().optional(),
    }),
  },
  relay_creds_set: {
    input: z.object({
      providerId: providerIdSchema,
      username: z.string().min(1).max(200),
      password: z.string().min(1).max(500),
    }).strict(),
    output: z.object({ stored: z.boolean() }),
  },
  relay_creds_clear: {
    input: z.object({ providerId: providerIdSchema }).strict(),
    output: z.object({ cleared: z.boolean() }),
  },
  relay_account_toggle: {
    input: z.object({ providerId: providerIdSchema, authIndex: z.string().min(1).max(200), enabled: z.boolean() }).strict(),
    output: z.object({ disabled: z.boolean() }),
  },
  rings_state: { input: z.null(), output: ringsStateSchema },
  rings_toggle: { input: ringsToggleInputSchema, output: ringsStateSchema },
  rings_size: { input: ringsSizeInputSchema, output: ringsStateSchema },
  rings_per_row: { input: ringsPerRowInputSchema, output: ringsStateSchema },
});

const CHANGED = "api-models-changed";

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Модели провайдера из models.json без мутации (read-only доступ для sync). */
function providerModels(file: ModelsFile, providerId: string): ModelEntry[] {
  const models = file.providers[providerId]?.models;
  if (!Array.isArray(models)) return [];
  return models.filter((model): model is ModelEntry =>
    !!model && typeof model === "object" && typeof (model as Record<string, unknown>).id === "string");
}

/** DonorView (§7): только id/name/enabled и несекретные лимиты/input. */
function donorView(entry: ModelEntry, enabled: boolean) {
  const view: {
    id: string; name?: string; enabled: boolean; contextWindow?: number; maxTokens?: number; input?: InputModality[];
  } = { id: entry.id, enabled };
  if (typeof entry.name === "string" && entry.name) view.name = entry.name;
  const contextWindow = positiveInteger(entry.contextWindow);
  if (contextWindow !== undefined) view.contextWindow = contextWindow;
  const maxTokens = positiveInteger(entry.maxTokens);
  if (maxTokens !== undefined) view.maxTokens = maxTokens;
  const input = inputModalities(entry.input);
  if (input) view.input = input;
  return view;
}

/** §3.2/§4.2: автодонор либо ручной выбор из candidates при tie; дубликат/несовпадение — отказ. */
function allowedDonor(match: ReturnType<typeof matchDonor>, donorId: string): boolean {
  return match.donor === donorId
    || (match.ambiguous === "tie" && match.candidates.some((candidate) => candidate.id === donorId));
}

/** Синхронизация не трогает выключенные/подключённые записи: только новые id из API. */
function syncScan(details: DiscoveredModel[], enabled: ModelEntry[], disabled: ModelEntry[]) {
  const known = new Set([...enabled, ...disabled].map((entry) => entry.id));
  const pool = [...enabled.map((entry) => ({ entry, enabled: true })), ...disabled.map((entry) => ({ entry, enabled: false }))];
  const byId = new Map(pool.map((item) => [item.entry.id, item]));
  return details
    .filter((model) => !known.has(model.id))
    .map((model) => {
      const match = matchDonor(model.id, pool.map((item) => ({ id: item.entry.id, enabled: item.enabled })));
      const view: {
        id: string; contextWindow?: number; maxTokens?: number; input?: InputModality[];
        supportedReasoningLevels?: DiscoveredModel["supportedReasoningLevels"];
        donor?: ReturnType<typeof donorView>; donorCandidates: Array<ReturnType<typeof donorView>>;
      } = { id: model.id, donorCandidates: [] };
      if (model.contextWindow !== undefined) view.contextWindow = model.contextWindow;
      if (model.maxTokens !== undefined) view.maxTokens = model.maxTokens;
      if (model.input) view.input = model.input;
      if (model.supportedReasoningLevels) view.supportedReasoningLevels = model.supportedReasoningLevels;
      const donor = match.donor ? byId.get(match.donor) : undefined;
      if (!match.donor && match.candidates.length > 0) {
        view.donorCandidates = match.candidates.map((candidate) => donorView(byId.get(candidate.id)!.entry, candidate.enabled));
      } else if (donor) {
        view.donor = donorView(donor.entry, donor.enabled);
      }
      return view;
    });
}

export default async function plugin(bb: BbPluginApi) {
  // Путь к файлу pi конфигурируется: Settings → Installed plugins → Api модели
  // или `bb plugin config clirelay-test set modelsPath <путь>`. Читается при
  // загрузке — после смены нужен `bb plugin reload clirelay-test`.
  const settings = bb.settings.define({
    modelsPath: { type: "string", label: "Путь к models.json pi (пусто = ~/.pi/agent/models.json)", default: "" },
    managementUser: { type: "string", label: "Логин админки clirelay (для квот аккаунтов)", secret: true },
    managementPassword: { type: "string", label: "Пароль админки clirelay", secret: true },
  });
  const { modelsPath, managementUser, managementPassword } = await settings.get();
  // PI_MODELS_PATH — тестовый шов, важнее настройки.
  const filePath = resolveModelsPath(process.env, modelsPath, homedir());

  // ponytail: внутрипроцессный lock (очередь промисов). Апгрейд при multi-process — файловые блокировки.
  let queue: Promise<unknown> = Promise.resolve();
  function locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn);
    queue = run.catch(() => undefined);
    return run;
  }
  function mutate<T>(fn: (file: ModelsFile) => T): Promise<T> {
    return locked(async () => {
      const file = await readModelsFile(filePath);
      const result = fn(file);
      await writeModelsFile(filePath, file);
      bb.realtime.publish(CHANGED, {});
      return result;
    });
  }
  const disabledKey = (providerId: string) => `disabled-models:${providerId}`;
  const readDisabled = async (providerId: string): Promise<ModelEntry[]> =>
    (await bb.storage.kv.get<ModelEntry[]>(disabledKey(providerId))) ?? [];

  // Кольца квот: выбранные аккаунты и размер живут в kv плагина. Читаем с
  // нормализацией — kv может содержать состояние прошлой версии.
  async function readRings(): Promise<RingsState> {
    return normalizeRingsState(await bb.storage.kv.get(RINGS_KV_KEY));
  }
  function mutateRings(fn: (state: RingsState) => RingsState): Promise<RingsState> {
    return locked(async () => {
      const next = normalizeRingsState(fn(await readRings()));
      await bb.storage.kv.set(RINGS_KV_KEY, next);
      bb.realtime.publish(RINGS_CHANGED, {});
      return next;
    });
  }

  // Management-доступ: креды per-origin (kv) → глобальный fallback; токен из
  // кэша сессии, при отзыве — один повторный логин.
  const credsFor = async (origin: string) =>
    (await bb.storage.kv.get<{ username: string; password: string }>(`relay-creds:${origin}`))
    ?? (managementUser && managementPassword ? { username: managementUser, password: managementPassword } : null);
  async function withManagement<T>(origin: string, fn: (token: string) => Promise<T>): Promise<T> {
    const creds = await credsFor(origin);
    if (!creds) throw new Error("креды админки не заданы");
    const cacheKey = `relay-auth:${origin}`;
    const cache = {
      get: async () => (await bb.storage.kv.get<RelaySession>(cacheKey)) ?? null,
      set: async (session: RelaySession) => { await bb.storage.kv.set(cacheKey, session); },
    };
    const token = await getManagementToken({ origin, creds, cache });
    try {
      return await fn(token);
    } catch (cause) {
      if (cause instanceof Error && /логин и пароль/.test(cause.message)) {
        const session = await loginRelay(origin, creds);
        await cache.set(session);
        return fn(session.access_token);
      }
      throw cause;
    }
  }

  /** Провайдер для sync: reads models.json под тем же lock, что и мутации. */
  const syncTarget = (providerId: string) => locked(async () => {
    const file = await readModelsFile(filePath);
    const entry = file.providers[providerId];
    if (!entry) throw new Error(`Провайдер не найден: ${providerId}`);
    if (typeof entry.baseUrl !== "string" || !entry.baseUrl) throw new Error("у провайдера не задан baseUrl");
    return { baseUrl: entry.baseUrl, apiKey: entry.apiKey as string | undefined };
  });

  /** Scan-срез: новые id + безопасные donor-предложения. Вызывается под lock. */
  const scanModels = async (providerId: string, details: DiscoveredModel[]) => {
    const file = await readModelsFile(filePath);
    if (!file.providers[providerId]) throw new Error(`Провайдер не найден: ${providerId}`);
    return syncScan(details, providerModels(file, providerId), await readDisabled(providerId));
  };

  bb.rpc.register(rpcContract, {
    providers_list: async () => {
      const views = listProviders(await readModelsFile(filePath));
      for (const view of views) view.disabled = (await readDisabled(view.id)).map(modelView);
      return { providers: views };
    },
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
    models_sync_scan: async ({ providerId }) => {
      const target = await syncTarget(providerId);
      const details = await discoverModelDetails(target.baseUrl, resolveApiKey(target.apiKey));
      return { models: await locked(() => scanModels(providerId, details)) };
    },
    model_sync_apply: async ({ providerId, modelId, donorId, replaceInPi }) => {
      // Сетевой fetch — без lock; чтение/запись файлов и kv — внутри locked.
      const target = await syncTarget(providerId);
      const details = await discoverModelDetails(target.baseUrl, resolveApiKey(target.apiKey));
      return locked(async () => {
        const file = await readModelsFile(filePath);
        const provider = file.providers[providerId];
        if (!provider) throw new Error(`Провайдер не найден: ${providerId}`);
        const disabled = await readDisabled(providerId);
        const settingsPath = resolveSettingsPath(filePath);
        const keys: SyncKeys = { providerId, donorId, modelId };
        const added = !hasModel(file, providerId, modelId) && !disabled.some((model) => model.id === modelId);

        if (added) {
          const discovered = details.find((model) => model.id === modelId);
          if (!discovered) throw new Error(`Модель не найдена в API: ${modelId}`);
          const pool = [
            ...providerModels(file, providerId).map((model) => ({ id: model.id, enabled: true })),
            ...disabled.map((model) => ({ id: model.id, enabled: false })),
          ];
          const match = matchDonor(modelId, pool);
          if (!allowedDonor(match, donorId)) throw new Error(`не подходит донор ${donorId} для ${modelId}`);
          const donor = providerModels(file, providerId).find((model) => model.id === donorId)
            ?? disabled.find((model) => model.id === donorId);
          if (!donor) throw new Error(`Донор не найден: ${donorId}`);

          const contextWindow = effectiveLimit(discovered.contextWindow, donor, "contextWindow");
          const maxTokens = effectiveLimit(discovered.maxTokens, donor, "maxTokens");
          const input = effectiveInput(discovered.input, donor);
          const clone = cloneDonorEntry(donor, modelId);
          if (contextWindow.value !== undefined) clone.contextWindow = contextWindow.value;
          if (maxTokens.value !== undefined) clone.maxTokens = maxTokens.value;
          if (input.value) clone.input = input.value;
          else delete clone.input;
          const reasoning = effectiveReasoning(discovered.supportedReasoningLevels, donor);
          // §5.3: без API-уровней и без donor.reasoning — поле не выдумываем.
          if (discovered.supportedReasoningLevels || donor.reasoning !== undefined) clone.reasoning = reasoning.reasoning;
          else delete clone.reasoning;
          if (reasoning.thinkingLevelMap) clone.thinkingLevelMap = reasoning.thinkingLevelMap;
          else delete clone.thinkingLevelMap;

          let settingsResult: "skipped" | "updated" | "unchanged" = "skipped";
          let patched: ReturnType<typeof patchSettings> | null = null;
          if (replaceInPi) {
            // §3.4: preflight settings до записи models — corrupt/invalid файл
            // не должен оставить подключённую модель с невалидным settings.
            const current = await readSettingsFile(settingsPath);
            validateSettings(current, keys);
            patched = patchSettings(current, keys);
            settingsResult = patched.changed ? "updated" : "unchanged";
          }

          addModelEntry(file, providerId, clone);
          await writeModelsFile(filePath, file);
          bb.realtime.publish(CHANGED, {});
          const sources = { contextWindow: contextWindow.source, maxTokens: maxTokens.source, input: input.source };
          if (patched?.changed) {
            try {
              await writeSettingsFile(settingsPath, patched.settings, keys);
            } catch {
              // §3.4: models уже записан → не откатываем; повтор доберёт settings.
              return { status: "partial" as const, modelAdded: true, settings: "failed" as const, sources };
            }
          }
          return { status: "applied" as const, modelAdded: true, settings: settingsResult, sources };
        }

        // Идемпотентный повтор: модели не перезаписываем, только недостающий settings.
        // Модель могла быть подключена обычным путём или уже удалена из API.
        if (!replaceInPi) return { status: "noop" as const, modelAdded: false, settings: "skipped" as const };
        // Retry не должен втянуть модель, которой нет в модели pi (disabled).
        if (!hasModel(file, providerId, modelId)) throw new Error(`Модель выключена или не подключена: ${modelId}`);
        // §4.2: та же проверка пары, что и в ветке added — не даём поставить чужим/старым донором.
        const retryPool = [
          ...providerModels(file, providerId).filter((model) => model.id !== modelId).map((model) => ({ id: model.id, enabled: true })),
          ...disabled.filter((model) => model.id !== modelId).map((model) => ({ id: model.id, enabled: false })),
        ];
        if (!allowedDonor(matchDonor(modelId, retryPool), donorId)) throw new Error(`не подходит донор ${donorId} для ${modelId}`);
        const current = await readSettingsFile(settingsPath);
        validateSettings(current, keys);
        const patched = patchSettings(current, keys);
        if (!patched.changed) return { status: "noop" as const, modelAdded: false, settings: "unchanged" as const };
        try {
          await writeSettingsFile(settingsPath, patched.settings, keys);
        } catch {
          return { status: "partial" as const, modelAdded: false, settings: "failed" as const };
        }
        // 7c: settings реально изменился → это applied, а не noop.
        return { status: "applied" as const, modelAdded: false, settings: "updated" as const };
      });
    },
    model_disconnect: async ({ providerId, modelId }) => ({
      removed: await locked(async () => {
        const file = await readModelsFile(filePath);
        let removed = disconnectModel(file, providerId, modelId);
        if (removed) {
          await writeModelsFile(filePath, file);
        } else {
          const disabled = await readDisabled(providerId);
          const next = disabled.filter((model) => model.id !== modelId);
          removed = next.length !== disabled.length;
          if (removed) await bb.storage.kv.set(disabledKey(providerId), next);
        }
        if (removed) bb.realtime.publish(CHANGED, {});
        return removed;
      }),
    }),
    model_toggle: async ({ providerId, modelId, enabled }) => ({
      enabled: await locked(async () => {
        const disabled = await readDisabled(providerId);
        const file = await readModelsFile(filePath);
        let fileChanged = false;
        if (!enabled) {
          const entry = removeModelEntry(file, providerId, modelId);
          if (entry) {
            disabled.push(entry);
            fileChanged = true;
          } else if (!disabled.some((model) => model.id === modelId)) {
            throw new Error(`Модель не найдена: ${modelId}`);
          }
        } else {
          const index = disabled.findIndex((model) => model.id === modelId);
          if (index >= 0) {
            const [entry] = disabled.splice(index, 1);
            addModelEntry(file, providerId, entry!);
            fileChanged = true;
          } else if (!hasModel(file, providerId, modelId)) {
            throw new Error(`Модель не найдена: ${modelId}`);
          }
        }
        await bb.storage.kv.set(disabledKey(providerId), disabled);
        if (fileChanged) await writeModelsFile(filePath, file);
        bb.realtime.publish(CHANGED, {});
        return enabled;
      }),
    }),
    model_update: async ({ providerId, modelId, patch }) =>
      locked(async () => {
        const file = await readModelsFile(filePath);
        if (hasModel(file, providerId, modelId)) {
          const result = updateModel(file, providerId, modelId, patch);
          await writeModelsFile(filePath, file);
          bb.realtime.publish(CHANGED, {});
          return modelView(result);
        }
        const disabled = await readDisabled(providerId);
        const entry = disabled.find((model) => model.id === modelId);
        if (!entry) throw new Error(`Модель не найдена: ${modelId}`);
        applyModelPatch(entry, patch);
        await bb.storage.kv.set(disabledKey(providerId), disabled);
        bb.realtime.publish(CHANGED, {});
        return modelView(entry);
      }),
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
    relay_accounts: async ({ providerId }) => {
      const file = await readModelsFile(filePath);
      const entry = file.providers[providerId];
      if (!entry) throw new Error(`Провайдер не найден: ${providerId}`);
      if (typeof entry.baseUrl !== "string" || !entry.baseUrl) throw new Error("у провайдера не задан baseUrl");
      const origin = relayOrigin(entry.baseUrl);
      if (!(await credsFor(origin))) return { configured: false, items: [] };
      try {
        const items = await withManagement(origin, async (token) => {
          const accounts = await fetchRelayAccounts(entry.baseUrl as string, token);
          const states = await fetchAuthFileStates(entry.baseUrl as string, token).catch(() => new Map<string, { name: string; disabled: boolean; email?: string; label?: string }>());
          for (const account of accounts) {
            const state = states.get(account.auth_index);
            // shared-аккаунтов нет в auth-files: disabled берём из health_status
            account.disabled = state ? state.disabled : account.health_status === "disabled";
            if (state) {
              account.auth_name = state.name;
              // undefined не проходит JSON-границу RPC — пишем только наявное
              if (state.email) account.email = state.email;
              if (state.label) account.label = state.label;
            }
          }
          return accounts;
        });
        return { configured: true, items };
      } catch (cause) {
        return { configured: true, items: [], error: cause instanceof Error ? cause.message : String(cause) };
      }
    },
    relay_account_toggle: async ({ providerId, authIndex, enabled }) => {
      const file = await readModelsFile(filePath);
      const entry = file.providers[providerId];
      if (!entry) throw new Error(`Провайдер не найден: ${providerId}`);
      if (typeof entry.baseUrl !== "string" || !entry.baseUrl) throw new Error("у провайдера не задан baseUrl");
      const origin = relayOrigin(entry.baseUrl);
      const disabled = await withManagement(origin, async (token) => {
        const states = await fetchAuthFileStates(entry.baseUrl as string, token);
        const state = states.get(authIndex);
        if (!state) throw new Error(`Аккаунт не найден в auth-files: ${authIndex}`);
        return setAuthFileDisabled(entry.baseUrl as string, token, state.name, !enabled);
      });
      return { disabled };
    },
    relay_creds_set: async ({ providerId, username, password }) => {
      const file = await readModelsFile(filePath);
      const entry = file.providers[providerId];
      if (!entry) throw new Error(`Провайдер не найден: ${providerId}`);
      if (typeof entry.baseUrl !== "string" || !entry.baseUrl) throw new Error("у провайдера не задан baseUrl");
      const origin = relayOrigin(entry.baseUrl);
      await bb.storage.kv.set(`relay-creds:${origin}`, { username, password });
      await bb.storage.kv.set(`relay-auth:${origin}`, null);
      return { stored: true };
    },
    relay_creds_clear: async ({ providerId }) => {
      const file = await readModelsFile(filePath);
      const entry = file.providers[providerId];
      if (!entry) throw new Error(`Провайдер не найден: ${providerId}`);
      if (typeof entry.baseUrl !== "string" || !entry.baseUrl) throw new Error("у провайдера не задан baseUrl");
      const origin = relayOrigin(entry.baseUrl);
      await bb.storage.kv.set(`relay-creds:${origin}`, null);
      await bb.storage.kv.set(`relay-auth:${origin}`, null);
      return { cleared: true };
    },
    rings_state: async () => readRings(),
    rings_toggle: async ({ key, on }) =>
      mutateRings((state) => ({
        ...state,
        selected: on ? [...state.selected, key] : state.selected.filter((entry) => entry !== key),
      })),
    rings_size: async ({ size }) => mutateRings((state) => ({ ...state, size: clampRingSize(size) })),
    rings_per_row: async ({ perRow }) => mutateRings((state) => ({ ...state, perRow: clampRingPerRow(perRow) })),
  });

  bb.log.info("api-models loaded");
}
