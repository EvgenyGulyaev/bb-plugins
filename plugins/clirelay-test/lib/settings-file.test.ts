import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  patchSettings,
  readSettingsFile,
  resolveSettingsPath,
  settingsSourceKey,
  validateSettings,
  writeSettingsFile,
} from "./settings-file";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "settings-file-"));
  dirs.push(dir);
  return dir;
}

const keys = { providerId: "router-test", donorId: "gpt-6.2-sol", modelId: "gpt-7.1-sol" };

describe("resolveSettingsPath / settingsSourceKey", () => {
  it("settings.json — сосед models.json", () => {
    expect(resolveSettingsPath("/home/u/.pi/agent/models.json")).toBe("/home/u/.pi/agent/settings.json");
    expect(resolveSettingsPath("/tmp/x/models.json")).toBe("/tmp/x/settings.json");
  });
  it("ключи provider/model, exact case-sensitive", () => {
    expect(settingsSourceKey(keys, "donor")).toBe("router-test/gpt-6.2-sol");
    expect(settingsSourceKey(keys, "new")).toBe("router-test/gpt-7.1-sol");
  });
});

describe("readSettingsFile / writeSettingsFile", () => {
  it("ENOENT → пустой объект", async () => {
    const path = join(await tempDir(), "settings.json");
    expect(await readSettingsFile(path)).toEqual({});
  });
  it("повреждённый JSON и не-object root не перезаписываются", async () => {
    const dir = await tempDir();
    for (const body of ["{oops", "[]", "null", '"str"']) {
      const path = join(dir, "settings.json");
      await writeFile(path, body, "utf8");
      await expect(readSettingsFile(path)).rejects.toThrow(/settings\.json повреждён/);
      await expect(writeSettingsFile(path, { enabledModels: [] })).rejects.toThrow();
      expect(await readFile(path, "utf8")).toBe(body);
    }
  });
  it("atomic write: tmp + rename + одна .bak, неизвестные поля сохранены", async () => {
    const path = join(await tempDir(), "settings.json");
    await writeFile(path, `${JSON.stringify({ keep: { a: 1 } })}\n`, "utf8");
    await writeSettingsFile(path, { keep: { a: 1 }, enabledModels: ["x/y"] });
    expect(await readFile(`${path}.bak`, "utf8")).toBe(`${JSON.stringify({ keep: { a: 1 } })}\n`);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ keep: { a: 1 }, enabledModels: ["x/y"] });
    expect(existsSync(join(path, "..", ".settings-"))).toBe(false);
  });
});

describe("validateSettings", () => {
  it("принимает отсутствующие ключи и корректные значения", () => {
    expect(() => validateSettings({})).not.toThrow();
    expect(() => validateSettings({ enabledModels: ["a/b", "c/d"], compaction: { modelOverrides: { "a/b": { x: 1 } } } })).not.toThrow();
  });
  it("отклоняет не-array enabledModels, non-string items, не-object compaction/overrides", () => {
    for (const bad of [
      { enabledModels: "a/b" },
      { enabledModels: { 0: "a/b" } },
      { enabledModels: ["a/b", 1] },
      { compaction: [] },
      { compaction: { modelOverrides: [] } },
      { compaction: { modelOverrides: { "a/b": "x" } } },
    ]) {
      expect(() => validateSettings(bad)).toThrow(/settings\.json/);
    }
  });
  it("проверяет только donor/new override, чужая битая запись не блокирует sync", () => {
    const keys = { providerId: "p", donorId: "gpt-6.2-sol", modelId: "gpt-7.1-sol" };
    const settings = { compaction: { modelOverrides: { "other/x": "broken", "p/gpt-6.2-sol": { keep: 1 } } } };
    expect(() => validateSettings(settings, keys)).not.toThrow();
    expect(() => validateSettings({ compaction: { modelOverrides: { "p/gpt-6.2-sol": "broken" } } }, keys)).toThrow(/settings\.json/);
    expect(() => validateSettings({ compaction: { modelOverrides: { "p/gpt-7.1-sol": 1 } } }, keys)).toThrow(/settings\.json/);
  });
});

describe("patchSettings — §6", () => {
  it("enabledModels absent → не создаётся, unchanged", () => {
    const result = patchSettings({ other: 1 }, keys);
    expect(result.changed).toBe(false);
    expect(result.settings).toEqual({ other: 1 });
  });
  it("exact donor заменяется на new на позиции первого donor, лишние exact убираются", () => {
    const result = patchSettings(
      { enabledModels: ["other/x", "router-test/gpt-6.2-sol", "wild/*", "router-test/gpt-7.1-sol", "router-test/gpt-6.2-sol", "gpt-6.2-sol"] },
      keys,
    );
    expect(result.changed).toBe(true);
    expect(result.settings.enabledModels).toEqual(["other/x", "router-test/gpt-7.1-sol", "wild/*", "gpt-6.2-sol"]);
  });
  it("exact donor отсутствует → enabledModels unchanged, новый не добавлен", () => {
    const result = patchSettings({ enabledModels: ["other/x", "router-test/gpt-6.2-sol-x"] }, keys);
    expect(result.changed).toBe(false);
    expect(result.settings.enabledModels).toEqual(["other/x", "router-test/gpt-6.2-sol-x"]);
  });
  it("compaction.modelOverrides: клон на new, donor сохранён, existing new не перезаписан", () => {
    const override = { contextWindow: 100, nested: { a: [1, 2] } };
    const settings = { compaction: { modelOverrides: { "router-test/gpt-6.2-sol": override, "router-test/gpt-7.1-sol": { keep: true } } } };
    const result = patchSettings(settings, keys);
    const overrides = (result.settings.compaction as { modelOverrides: Record<string, unknown> }).modelOverrides;
    expect(overrides["router-test/gpt-6.2-sol"]).toEqual(override);
    expect(overrides["router-test/gpt-7.1-sol"]).toEqual({ keep: true });
    expect(result.changed).toBe(false);
  });
  it("compaction.modelOverrides: donor без new → deep clone на new, donor сохранён", () => {
    const override = { contextWindow: 100, nested: { a: [1, 2] } };
    const settings = { compaction: { modelOverrides: { "router-test/gpt-6.2-sol": override } } };
    const result = patchSettings(settings, keys);
    const overrides = (result.settings.compaction as { modelOverrides: Record<string, unknown> }).modelOverrides;
    expect(overrides["router-test/gpt-6.2-sol"]).toEqual(override);
    expect(overrides["router-test/gpt-7.1-sol"]).toEqual(override);
    expect(overrides["router-test/gpt-7.1-sol"]).not.toBe(override);
    expect(result.changed).toBe(true);
    expect(settings.compaction).toEqual({ modelOverrides: { "router-test/gpt-6.2-sol": override } });
  });
  it("donor override отсутствует → пустой modelOverrides не создаётся", () => {
    const result = patchSettings({ compaction: { modelOverrides: { "other/x": { a: 1 } } } }, keys);
    expect(result.changed).toBe(false);
    expect(result.settings.compaction).toEqual({ modelOverrides: { "other/x": { a: 1 } } });
  });
  it("не трогает defaultModel/defaultProvider/modelThinkingLevels и прочие ключи", () => {
    const settings = {
      defaultModel: "router-test/gpt-6.2-sol",
      defaultProvider: "router-test",
      modelThinkingLevels: { "router-test/gpt-6.2-sol": "high" },
      enabledModels: ["router-test/gpt-6.2-sol"],
      extra: [1, 2],
    };
    const result = patchSettings(settings, keys);
    expect(result.settings).toEqual({
      defaultModel: "router-test/gpt-6.2-sol",
      defaultProvider: "router-test",
      modelThinkingLevels: { "router-test/gpt-6.2-sol": "high" },
      enabledModels: ["router-test/gpt-7.1-sol"],
      extra: [1, 2],
    });
  });
  it("new ставится на позицию первого donor: ['p/n','x','p/d'] → ['x','p/n']", () => {
    const result = patchSettings({ enabledModels: ["p/n", "x", "p/d"] }, { providerId: "p", donorId: "d", modelId: "n" });
    expect(result.changed).toBe(true);
    expect(result.settings.enabledModels).toEqual(["x", "p/n"]);
  });
  it("exact donor отсутствует, есть new → enabledModels байт-в-байт", () => {
    const result = patchSettings({ enabledModels: ["p/n", "x", "p/n"] }, { providerId: "p", donorId: "d", modelId: "n" });
    expect(result.changed).toBe(false);
    expect(result.settings.enabledModels).toEqual(["p/n", "x", "p/n"]);
  });
  it("нет ни donor, ни new → enabledModels байт-в-байт", () => {
    const result = patchSettings({ enabledModels: ["p/n", "p/n"] }, { providerId: "p", donorId: "d", modelId: "n" });
    expect(result.changed).toBe(false);
    expect(result.settings.enabledModels).toEqual(["p/n", "p/n"]);
  });
  it("идемпотентен: повтор даёт тот же JSON", () => {
    const once = patchSettings({ enabledModels: ["router-test/gpt-6.2-sol"], compaction: { modelOverrides: { "router-test/gpt-6.2-sol": { a: 1 } } } }, keys);
    const twice = patchSettings(once.settings, keys);
    expect(JSON.stringify(twice.settings)).toBe(JSON.stringify(once.settings));
    expect(twice.changed).toBe(false);
  });
});
