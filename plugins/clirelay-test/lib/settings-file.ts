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
 * типа. Отклоняем заранее, чтобы не записать ни models, ни settings. Если
 * переданы `keys`, проверяем только donor/new override — чужая битая запись
 * sync не блокирует.
 */
export function validateSettings(settings: SettingsFile, keys?: SyncKeys): void {
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
      const touched = keys ? [settingsSourceKey(keys, "donor"), settingsSourceKey(keys, "new")] : Object.keys(overrides);
      for (const key of touched) {
        if (key in overrides && !plainObject(overrides[key])) throw new Error(`settings.json: compaction.modelOverrides["${key}"] должен быть объектом`);
      }
    }
  }
}

// ponytail: одна ротация .bak, как в models-file; апгрейд — нумерованные копии.
export async function writeSettingsFile(path: string, data: SettingsFile, keys?: SyncKeys): Promise<void> {
  validateSettings(data, keys);
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
    const list = models as string[];
    const at = list.indexOf(donorKey);
    // §6: exact donor отсутствует → enabledModels не трогаем.
    if (at >= 0) {
      const before = list.slice(0, at).filter((item) => item !== newKey);
      const after = list.slice(at + 1).filter((item) => item !== donorKey && item !== newKey);
      const result = [...before, newKey, ...after];
      if (JSON.stringify(result) !== JSON.stringify(list)) {
        next.enabledModels = result;
        changed = true;
      }
    }
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
