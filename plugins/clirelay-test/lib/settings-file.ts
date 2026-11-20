import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface SettingsFile { [key: string]: unknown }

export interface SyncKeys { providerId: string; donorId: string; modelId: string }

const CORRUPT = "settings.json повреждён или не является объектом — файл не изменён";

/** settings.json лежит рядом с models.json (спека §6), без отдельной настройки. */
export function resolveSettingsPath(modelsPath: string): string {
  return join(dirname(modelsPath), "settings.json");
}

export function settingsSourceKey(keys: SyncKeys, kind: "donor" | "new"): string {
  return `${keys.providerId}/${kind === "donor" ? keys.donorId : keys.modelId}`;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export async function readSettingsFile(path: string): Promise<SettingsFile> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw cause;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(CORRUPT);
  }
  if (!plainObject(parsed)) throw new Error(CORRUPT);
  return parsed;
}

/**
 * §6 preflight: структуры, которые мы собираемся патчить, обязаны быть того же
 * типа. Отклоняем заранее, чтобы не записать ни models, ни settings.
 */
export function validateSettings(settings: SettingsFile): void {
  const { enabledModels, compaction } = settings;
  if (enabledModels !== undefined) {
    if (!Array.isArray(enabledModels)) throw new Error("settings.json: enabledModels должен быть массивом строк");
    if (enabledModels.some((item) => typeof item !== "string")) throw new Error("settings.json: enabledModels содержит не строку");
  }
  if (compaction !== undefined) {
    if (!plainObject(compaction)) throw new Error("settings.json: compaction должен быть объектом");
    const overrides = compaction.modelOverrides;
    if (overrides !== undefined) {
      if (!plainObject(overrides)) throw new Error("settings.json: compaction.modelOverrides должен быть объектом");
      for (const [key, value] of Object.entries(overrides)) {
        if (!plainObject(value)) throw new Error(`settings.json: compaction.modelOverrides["${key}"] должен быть объектом`);
      }
    }
  }
}

// ponytail: одна ротация .bak, как в models-file; апгрейд — нумерованные копии.
export async function writeSettingsFile(path: string, data: SettingsFile): Promise<void> {
  validateSettings(data);
  // Не перезаписываем повреждённый файл: читаем прежнее состояние до записи.
  await readSettingsFile(path);
  await mkdir(dirname(path), { recursive: true });
  try {
    await copyFile(path, `${path}.bak`);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  const tmp = join(dirname(path), `.settings-${process.pid}-${Date.now()}.tmp`);
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

export interface PatchResult { settings: SettingsFile; changed: boolean }

/**
 * §6: патчим только exact `provider/model` ключи. Wildcards, partial patterns и
 * чужие записи остаются как есть; defaultModel/defaultProvider не трогаем.
 */
export function patchSettings(settings: SettingsFile, keys: SyncKeys): PatchResult {
  const next: SettingsFile = structuredClone(settings);
  let changed = false;
  const donorKey = settingsSourceKey(keys, "donor");
  const newKey = settingsSourceKey(keys, "new");

  const models = next.enabledModels;
  if (Array.isArray(models)) {
    let placed = false;
    const result: string[] = [];
    for (const item of models as string[]) {
      if (item === donorKey || item === newKey) {
        if (placed) {
          changed = true;
          continue; // лишние exact-дубликаты target убираем
        }
        placed = true;
        result.push(newKey);
        if (item !== newKey) changed = true;
        continue;
      }
      result.push(item);
    }
    if (changed || result.length !== models.length) next.enabledModels = result;
  }

  const compaction = next.compaction;
  if (plainObject(compaction)) {
    const overrides = compaction.modelOverrides;
    if (plainObject(overrides) && donorKey in overrides && !(newKey in overrides)) {
      const donorOverride = overrides[donorKey];
      if (plainObject(donorOverride)) {
        overrides[newKey] = structuredClone(donorOverride);
        changed = true;
      }
    }
  }

  return { settings: next, changed };
}
