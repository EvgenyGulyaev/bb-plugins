import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ModelPatch, ProviderView } from "./schema";

export type { ProviderView } from "./schema";

export type ProviderEntry = Record<string, unknown>;
export type ModelEntry = { id: string } & Record<string, unknown>;
export interface ModelsFile { providers: Record<string, ProviderEntry>; [key: string]: unknown }

// Приоритет: тестовый env → настройка плагина → дефолт pi.
export function resolveModelsPath(env: NodeJS.ProcessEnv, configured: string | undefined, home: string): string {
  if (env.PI_MODELS_PATH) return env.PI_MODELS_PATH;
  const trimmed = configured?.trim();
  if (trimmed) return trimmed;
  return join(home, ".pi", "agent", "models.json");
}

const CORRUPT = "models.json повреждён или не является объектом — файл не изменён";

export async function readModelsFile(path: string): Promise<ModelsFile> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { providers: {} };
    throw cause;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(CORRUPT);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(CORRUPT);
  const file = parsed as ModelsFile;
  if (file.providers === undefined) file.providers = {};
  if (!file.providers || typeof file.providers !== "object" || Array.isArray(file.providers)) throw new Error(CORRUPT);
  return file;
}

// ponytail: одна ротация .bak; апгрейд при необходимости — нумерованные копии.
export async function writeModelsFile(path: string, data: ModelsFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await copyFile(path, `${path}.bak`);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  const tmp = join(dirname(path), `.models-${process.pid}-${Date.now()}.tmp`);
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

function provider(file: ModelsFile, id: string): ProviderEntry {
  const entry = file.providers[id];
  if (!entry || typeof entry !== "object") throw new Error(`Провайдер не найден: ${id}`);
  return entry;
}

function modelsArray(entry: ProviderEntry): ModelEntry[] {
  if (!Array.isArray(entry.models)) entry.models = [];
  return entry.models as ModelEntry[];
}

export function upsertProvider(
  file: ModelsFile,
  input: {
    id: string; name?: string; baseUrl: string; api: string; apiKey?: string;
    authHeader?: boolean | null; oauth?: string | null;
    compat?: Record<string, unknown> | null; headers?: Record<string, string> | null;
  },
): void {
  const next: ProviderEntry = { ...(file.providers[input.id] ?? {}), baseUrl: input.baseUrl, api: input.api };
  if (input.name) next.name = input.name;
  else delete next.name;
  if (input.apiKey) next.apiKey = input.apiKey; // пусто → прежний ключ сохраняется
  for (const key of ["authHeader", "oauth", "compat"] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  if (input.headers !== undefined) {
    if (input.headers === null) delete next.headers;
    else {
      const merged = mergeHeaders(next.headers, input.headers);
      if (merged) next.headers = merged;
      else delete next.headers;
    }
  }
  file.providers[input.id] = next;
}

export function deleteProvider(file: ModelsFile, id: string): boolean {
  if (!(id in file.providers)) return false;
  delete file.providers[id];
  return true;
}

export function connectModel(file: ModelsFile, providerId: string, modelId: string): boolean {
  const models = modelsArray(provider(file, providerId));
  if (models.some((model) => model.id === modelId)) return false;
  models.push({ id: modelId });
  return true;
}

export function disconnectModel(file: ModelsFile, providerId: string, modelId: string): boolean {
  const entry = provider(file, providerId);
  const models = modelsArray(entry);
  const next = models.filter((model) => model.id !== modelId);
  if (next.length === models.length) return false;
  entry.models = next;
  return true;
}

// Выключение модели: запись переезжает в kv плагина, настройки сохраняются.
export function removeModelEntry(file: ModelsFile, providerId: string, modelId: string): ModelEntry | null {
  const models = modelsArray(provider(file, providerId));
  const index = models.findIndex((model) => model.id === modelId);
  if (index < 0) return null;
  const [entry] = models.splice(index, 1);
  return entry!;
}

export function addModelEntry(file: ModelsFile, providerId: string, entry: ModelEntry): boolean {
  const models = modelsArray(provider(file, providerId));
  if (models.some((model) => model.id === entry.id)) return false;
  models.push(entry);
  return true;
}

export function hasModel(file: ModelsFile, providerId: string, modelId: string): boolean {
  return modelsArray(provider(file, providerId)).some((model) => model.id === modelId);
}

// Мерж заголовков по ключам: "" удаляет ключ; пустой результат → null (поле удаляется).
export function mergeHeaders(current: unknown, patch: Record<string, string>): Record<string, unknown> | null {
  const base: Record<string, unknown> =
    current && typeof current === "object" && !Array.isArray(current) ? { ...(current as Record<string, unknown>) } : {};
  for (const [name, value] of Object.entries(patch)) {
    if (value === "") delete base[name];
    else base[name] = value;
  }
  return Object.keys(base).length ? base : null;
}

// Единое применение патча: enabled (updateModel) и disabled (server.ts) — один код.
export function applyModelPatch(model: ModelEntry, patch: ModelPatch): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) { delete model[key]; continue; }
    if (key === "apiKey") {
      if (value === "") delete model.apiKey;
      else model.apiKey = value;
      continue;
    }
    if (key === "headers") {
      const next = mergeHeaders(model.headers, value as Record<string, string>);
      if (next) model.headers = next;
      else delete model.headers;
      continue;
    }
    model[key] = value;
  }
}

export type ModelView = ModelEntry & { apiKeySet: boolean; headersSet: boolean; headerNames: string[] };

// RPC-граница: apiKey и значения headers не отдаются никогда; только флаги и имена.
export function modelView(entry: ModelEntry): ModelView {
  const { apiKey, headers, ...rest } = entry;
  const headerNames = headers && typeof headers === "object" && !Array.isArray(headers) ? Object.keys(headers) : [];
  return {
    ...rest,
    apiKeySet: typeof apiKey === "string" && apiKey.length > 0,
    headersSet: headerNames.length > 0,
    headerNames,
  };
}

export function updateModel(
  file: ModelsFile, providerId: string, modelId: string, patch: ModelPatch,
): ModelEntry {
  const model = modelsArray(provider(file, providerId)).find((entry) => entry.id === modelId);
  if (!model) throw new Error(`Модель не найдена: ${modelId}`);
  applyModelPatch(model, patch);
  return model;
}

export function listProviders(file: ModelsFile): ProviderView[] {
  return Object.entries(file.providers).map(([id, entry]) => {
    const headers = entry.headers && typeof entry.headers === "object" && !Array.isArray(entry.headers)
      ? (entry.headers as Record<string, unknown>) : null;
    return {
      id,
      // RPC-граница требует чистый JSON: отсутствующее имя не пишем вовсе.
      ...(typeof entry.name === "string" ? { name: entry.name } : {}),
      baseUrl: typeof entry.baseUrl === "string" ? entry.baseUrl : "",
      api: typeof entry.api === "string" ? entry.api : "openai-completions",
      apiKeySet: typeof entry.apiKey === "string" && entry.apiKey.length > 0,
      ...(entry.authHeader === true ? { authHeader: true } : {}),
      ...(typeof entry.oauth === "string" ? { oauth: entry.oauth } : {}),
      ...(entry.compat && typeof entry.compat === "object" && !Array.isArray(entry.compat) ? { compat: entry.compat as Record<string, unknown> } : {}),
      headersSet: !!headers && Object.keys(headers).length > 0,
      headerNames: headers ? Object.keys(headers) : [],
      disabled: [],
      models: (Array.isArray(entry.models) ? entry.models : [])
        .filter((model): model is ModelEntry =>
          !!model && typeof model === "object" && typeof (model as Record<string, unknown>).id === "string")
        .map(modelView),
    };
  });
}
