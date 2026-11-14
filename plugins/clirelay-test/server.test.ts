import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./server.js";

type Host = ReturnType<typeof createFakePluginHost>;
const hosts: Host[] = [];

async function load(content?: string) {
  const dir = await mkdtemp(join(tmpdir(), "api-models-rpc-"));
  const path = join(dir, "models.json");
  if (content !== undefined) await writeFile(path, content);
  process.env.PI_MODELS_PATH = path;
  const host = createFakePluginHost({ pluginId: "clirelay-test" });
  await plugin(host.bb);
  hosts.push(host);
  return { host, path };
}

afterEach(async () => {
  delete process.env.PI_MODELS_PATH;
  vi.unstubAllGlobals();
  await Promise.all(hosts.splice(0).map((host) => host.harness.lifecycle.dispose()));
});

describe("RPC", () => {
  it("пустой файл → пустой список", async () => {
    const { host } = await load();
    expect(await host.harness.behavior.callRpc("providers_list", null)).toEqual({ providers: [] });
  });
  it("provider_save → apiKeySet, ключ не утекает; model_connect/update/disconnect", async () => {
    const { host, path } = await load();
    const saved = await host.harness.behavior.callRpc("provider_save", {
      id: "router-test", name: "Test", baseUrl: "http://localhost:4010/v1", api: "openai-completions", apiKey: "test-key",
    }) as Record<string, unknown>;
    expect(saved.apiKeySet).toBe(true);
    expect(JSON.stringify(saved)).not.toContain("test-key");
    expect(await host.harness.behavior.callRpc("model_connect", { providerId: "router-test", modelId: "m1" })).toEqual({ connected: true });
    expect(await host.harness.behavior.callRpc("model_connect", { providerId: "router-test", modelId: "m1" })).toEqual({ connected: false });
    await host.harness.behavior.callRpc("model_update", { providerId: "router-test", modelId: "m1", patch: { reasoning: true, contextWindow: 400000 } });
    const { providers } = await host.harness.behavior.callRpc("providers_list", null) as { providers: Array<{ models: Array<Record<string, unknown>> }> };
    expect(providers[0]!.models[0]).toMatchObject({ id: "m1", reasoning: true, contextWindow: 400000 });
    expect(JSON.parse(await readFile(path, "utf8")).providers["router-test"].apiKey).toBe("test-key");
    expect(await host.harness.behavior.callRpc("model_disconnect", { providerId: "router-test", modelId: "m1" })).toEqual({ removed: true });
    expect(await host.harness.behavior.callRpc("provider_delete", { id: "router-test" })).toEqual({ removed: true });
  });
  it("пустой apiKey при правке сохраняет прежний", async () => {
    const { host, path } = await load();
    await host.harness.behavior.callRpc("provider_save", { id: "p", baseUrl: "http://localhost:4010/v1", api: "openai-completions", apiKey: "test-key" });
    await host.harness.behavior.callRpc("provider_save", { id: "p", baseUrl: "http://localhost:4011/v1", api: "openai-completions" });
    expect(JSON.parse(await readFile(path, "utf8")).providers.p.apiKey).toBe("test-key");
  });
  it("битый файл не перезаписывается", async () => {
    const { host, path } = await load("{oops");
    await expect(host.harness.behavior.callRpc("providers_list", null)).rejects.toThrow(/повреждён/);
    await expect(host.harness.behavior.callRpc("provider_save", { id: "p", baseUrl: "http://localhost:4010/v1", api: "openai-completions" })).rejects.toThrow(/повреждён/);
    expect(await readFile(path, "utf8")).toBe("{oops");
  });
  it("невалидный вход отклоняется zod", async () => {
    const { host } = await load();
    await expect(host.harness.behavior.callRpc("provider_save", { id: "Bad Id", baseUrl: "http://localhost:4010/v1", api: "openai-completions" })).rejects.toThrow();
    await expect(host.harness.behavior.callRpc("model_update", { providerId: "p", modelId: "m", patch: { reasoning: "yes" } })).rejects.toThrow();
  });
  it("путь берётся из настройки плагина, когда env не задан", async () => {
    const dir = await mkdtemp(join(tmpdir(), "api-models-cfg-"));
    const path = join(dir, "models.json");
    await writeFile(path, JSON.stringify({ providers: { cfg: { baseUrl: "http://localhost:4010/v1", api: "openai-completions", models: [] } } }));
    delete process.env.PI_MODELS_PATH;
    const host = createFakePluginHost({ pluginId: "clirelay-test", settings: { modelsPath: path } });
    await plugin(host.bb);
    hosts.push(host);
    const { providers } = await host.harness.behavior.callRpc("providers_list", null) as { providers: Array<{ id: string }> };
    expect(providers.map((p) => p.id)).toEqual(["cfg"]);
  });
  it("model_test: ok через chat/completions; неподдерживаемый api → отказ", async () => {
    const { host } = await load();
    await host.harness.behavior.callRpc("provider_save", { id: "p", baseUrl: "http://localhost:4010/v1", api: "openai-completions", apiKey: "test-key" });
    await host.harness.behavior.callRpc("model_connect", { providerId: "p", modelId: "m1" });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await host.harness.behavior.callRpc("model_test", { providerId: "p", modelId: "m1" }) as { ok: boolean; detail: string };
    expect(result.ok).toBe(true);
    expect(result.detail).toBe("OK");
    await host.harness.behavior.callRpc("provider_save", { id: "p", baseUrl: "http://localhost:4010/v1", api: "anthropic-messages" });
    const refused = await host.harness.behavior.callRpc("model_test", { providerId: "p", modelId: "m1" }) as { ok: boolean; detail: string };
    expect(refused.ok).toBe(false);
    expect(refused.detail).toContain("openai-completions");
  });
  it("provider_usage отдаёт summary relay без ключа в ответе", async () => {
    const { host } = await load();
    await host.harness.behavior.callRpc("provider_save", { id: "p", baseUrl: "http://localhost:4010/v1", api: "openai-completions", apiKey: "test-key" });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ found: true, range: "today", stats: { total_calls: 3, quota_cost: 0.1 }, limits: null, "quota-scopes": [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const summary = await host.harness.behavior.callRpc("provider_usage", { providerId: "p" }) as { found: boolean; stats: { total_calls: number } };
    expect(summary.found).toBe(true);
    expect(summary.stats.total_calls).toBe(3);
    expect(JSON.stringify(summary)).not.toContain("test-key");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:4010/v0/management/public/usage/summary");
    expect(JSON.parse(String(init.body))).toEqual({ api_key: "test-key" });
    await expect(host.harness.behavior.callRpc("provider_usage", { providerId: "missing" })).rejects.toThrow(/не найден/);
  });
  it("models_discover ходит с Bearer и отдаёт id", async () => {
    const { host } = await load();
    await host.harness.behavior.callRpc("provider_save", { id: "p", baseUrl: "http://localhost:4010/v1", api: "openai-completions", apiKey: "test-key" });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "m2" }, { id: "m1" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await host.harness.behavior.callRpc("models_discover", { providerId: "p" })).toEqual({ models: ["m1", "m2"] });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:4010/v1/models");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
  });
});
