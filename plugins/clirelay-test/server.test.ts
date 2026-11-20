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

  describe("API-настройки модели", () => {
    const FILE = JSON.stringify({
      providers: {
        "router-gpt": {
          baseUrl: "http://localhost:4010/v1", api: "openai-completions", apiKey: "prov-key", authHeader: true,
          models: [{ id: "gpt-6.2-sol", apiKey: "model-key", headers: { "X-M": "model-secret" }, reasoning: true }],
        },
      },
    });
    it("model_update: новые поля пишутся в файл, ответ и providers_list без секретов", async () => {
      const { host, path } = await load(FILE);
      const patch = {
        thinkingLevelMap: { off: null, low: "low", high: "high" },
        samplingParams: { reasoning_effort: "high" },
        compat: { supportsDeveloperRole: false, supportsStore: false, promptCacheKeyMode: "disabled" },
        cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
        promptCache: { short: 300 }, inputLimits: { maxRequestBytes: 100 },
        api: "openai-completions", baseUrl: "http://localhost:4011/v1",
      };
      const updated = await host.harness.behavior.callRpc("model_update", { providerId: "router-gpt", modelId: "gpt-6.2-sol", patch });
      const dump = JSON.stringify(updated);
      for (const secret of ["model-key", "model-secret", "prov-key"]) expect(dump).not.toContain(secret);
      expect(updated).toMatchObject({ id: "gpt-6.2-sol", apiKeySet: true, headersSet: true, headerNames: ["X-M"] });
      const onDisk = JSON.parse(await readFile(path, "utf8")).providers["router-gpt"].models[0];
      expect(onDisk.samplingParams).toEqual({ reasoning_effort: "high" });
      expect(onDisk.compat.promptCacheKeyMode).toBe("disabled");
      expect(onDisk.apiKey).toBe("model-key"); // патч не трогал ключ
      expect(onDisk.headers).toEqual({ "X-M": "model-secret" });
      const { providers } = await host.harness.behavior.callRpc("providers_list", null) as { providers: Array<Record<string, unknown>> };
      expect(JSON.stringify(providers)).not.toContain("model-secret");
      expect(providers[0]).toMatchObject({ authHeader: true, headersSet: false });
    });
    it("ключ модели: установка и очистка через RPC", async () => {
      const { host, path } = await load(FILE);
      await host.harness.behavior.callRpc("model_update", { providerId: "router-gpt", modelId: "gpt-6.2-sol", patch: { apiKey: "new-model-key" } });
      expect(JSON.parse(await readFile(path, "utf8")).providers["router-gpt"].models[0].apiKey).toBe("new-model-key");
      const cleared = await host.harness.behavior.callRpc("model_update", { providerId: "router-gpt", modelId: "gpt-6.2-sol", patch: { apiKey: "" } }) as Record<string, unknown>;
      expect(cleared.apiKeySet).toBe(false);
      expect(JSON.stringify(cleared)).not.toContain("new-model-key");
      expect(JSON.parse(await readFile(path, "utf8")).providers["router-gpt"].models[0].apiKey).toBeUndefined();
    });
    it("headers модели: мерж сохраняет невидимые значения, \"\" удаляет, null очищает", async () => {
      const { host, path } = await load(FILE);
      await host.harness.behavior.callRpc("model_update", { providerId: "router-gpt", modelId: "gpt-6.2-sol", patch: { headers: { "X-New": "$ENV" } } });
      expect(JSON.parse(await readFile(path, "utf8")).providers["router-gpt"].models[0].headers).toEqual({ "X-M": "model-secret", "X-New": "$ENV" });
      await host.harness.behavior.callRpc("model_update", { providerId: "router-gpt", modelId: "gpt-6.2-sol", patch: { headers: { "X-M": "" } } });
      expect(JSON.parse(await readFile(path, "utf8")).providers["router-gpt"].models[0].headers).toEqual({ "X-New": "$ENV" });
      await host.harness.behavior.callRpc("model_update", { providerId: "router-gpt", modelId: "gpt-6.2-sol", patch: { headers: null } });
      expect(JSON.parse(await readFile(path, "utf8")).providers["router-gpt"].models[0].headers).toBeUndefined();
    });
    it("disabled-модель: патч применяется, секреты не утекают через providers_list", async () => {
      const { host } = await load(FILE);
      await host.harness.behavior.callRpc("model_toggle", { providerId: "router-gpt", modelId: "gpt-6.2-sol", enabled: false });
      const updated = await host.harness.behavior.callRpc("model_update", { providerId: "router-gpt", modelId: "gpt-6.2-sol", patch: { samplingParams: { temperature: 0.5 }, apiKey: "" } });
      expect(updated).toMatchObject({ id: "gpt-6.2-sol", apiKeySet: false });
      expect(JSON.stringify(updated)).not.toContain("model-secret");
      const { providers } = await host.harness.behavior.callRpc("providers_list", null) as { providers: Array<{ disabled: Array<Record<string, unknown>> }> };
      expect(providers[0]!.disabled[0]).toMatchObject({ samplingParams: { temperature: 0.5 }, apiKeySet: false, headerNames: ["X-M"] });
      expect(JSON.stringify(providers)).not.toContain("model-secret");
      expect(JSON.stringify(providers)).not.toContain("model-key");
    });
    it("невалидные JSON-поля отклоняются контрактом, файл не меняется", async () => {
      const { host, path } = await load(FILE);
      const before = await readFile(path, "utf8");
      await expect(host.harness.behavior.callRpc("model_update", { providerId: "router-gpt", modelId: "gpt-6.2-sol", patch: { compat: { supportsStore: "false" } } })).rejects.toThrow();
      await expect(host.harness.behavior.callRpc("model_update", { providerId: "router-gpt", modelId: "gpt-6.2-sol", patch: { cost: { input: 1 } } })).rejects.toThrow();
      expect(await readFile(path, "utf8")).toBe(before);
    });
    it("старый патч из пяти полей работает как раньше", async () => {
      const { host, path } = await load(FILE);
      await host.harness.behavior.callRpc("model_update", { providerId: "router-gpt", modelId: "gpt-6.2-sol", patch: { name: "Sol", contextWindow: 500000, maxTokens: null } });
      const model = JSON.parse(await readFile(path, "utf8")).providers["router-gpt"].models[0];
      expect(model.name).toBe("Sol");
      expect(model.contextWindow).toBe(500000);
      expect(model.maxTokens).toBeUndefined();
    });
  });

  describe("API-настройки провайдера", () => {
    it("provider_save: authHeader/oauth/compat/headers roundtrip, null удаляет, секреты не в ответе", async () => {
      const { host, path } = await load();
      const saved = await host.harness.behavior.callRpc("provider_save", {
        id: "p", baseUrl: "http://localhost:4010/v1", api: "openai-completions", apiKey: "prov-key",
        authHeader: true, oauth: "radius", compat: { supportsStore: false }, headers: { "X-P": "prov-secret" },
      }) as Record<string, unknown>;
      expect(saved).toMatchObject({ authHeader: true, oauth: "radius", compat: { supportsStore: false }, headersSet: true, headerNames: ["X-P"] });
      expect(JSON.stringify(saved)).not.toContain("prov-secret");
      expect(JSON.stringify(saved)).not.toContain("prov-key");
      const onDisk = JSON.parse(await readFile(path, "utf8")).providers.p;
      expect(onDisk.headers).toEqual({ "X-P": "prov-secret" });
      await host.harness.behavior.callRpc("provider_save", { id: "p", baseUrl: "http://localhost:4010/v1", api: "openai-completions", headers: { "X-Q": "v2" } });
      expect(JSON.parse(await readFile(path, "utf8")).providers.p.headers).toEqual({ "X-P": "prov-secret", "X-Q": "v2" });
      const cleared = await host.harness.behavior.callRpc("provider_save", { id: "p", baseUrl: "http://localhost:4010/v1", api: "openai-completions", authHeader: null, oauth: null, compat: null, headers: null }) as Record<string, unknown>;
      expect(cleared.headersSet).toBe(false);
      expect(cleared.authHeader).toBeUndefined();
      const final = JSON.parse(await readFile(path, "utf8")).providers.p;
      expect(final.headers).toBeUndefined();
      expect(final.compat).toBeUndefined();
      expect(final.apiKey).toBe("prov-key");
    });
    it("невалидный compat провайдера отклоняется", async () => {
      const { host } = await load();
      await expect(host.harness.behavior.callRpc("provider_save", { id: "p", baseUrl: "http://localhost:4010/v1", api: "openai-completions", compat: { promptCacheKeyMode: "wrong" } })).rejects.toThrow();
    });
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
  it("relay_accounts: без кредов configured:false, с кредами — login + Bearer и квоты без утечки", async () => {
    const { host } = await load();
    await host.harness.behavior.callRpc("provider_save", { id: "p", baseUrl: "http://localhost:4010/v1", api: "openai-completions", apiKey: "test-key" });
    const empty = await host.harness.behavior.callRpc("relay_accounts", { providerId: "p" }) as { configured: boolean; items: unknown[] };
    expect(empty.configured).toBe(false);
    expect(empty.items).toEqual([]);
    const host2 = createFakePluginHost({ pluginId: "clirelay-test", settings: { managementUser: "admin", managementPassword: "test-pass" } });
    await plugin(host2.bb);
    hosts.push(host2);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "test-access", refresh_token: "test-refresh", expires_at: new Date(Date.now() + 3600_000).toISOString() }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ auth_index: "claude:u@example.com", quotas: [{ quota_key: "5h", percent: 100 }] }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await host2.harness.behavior.callRpc("relay_accounts", { providerId: "p" }) as { configured: boolean; items: Array<{ auth_index: string }> };
    expect(result.configured).toBe(true);
    expect(result.items[0]!.auth_index).toBe("claude:u@example.com");
    expect(JSON.stringify(result)).not.toContain("test-pass");
    expect(JSON.stringify(result)).not.toContain("test-access");
    const [loginUrl, loginInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(loginUrl).toBe("http://localhost:4010/v0/auth/login");
    expect(JSON.parse(String(loginInit.body))).toMatchObject({ username: "admin", password: "test-pass" });
    const [accountsUrl, accountsInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(accountsUrl).toBe("http://localhost:4010/v0/management/ai-accounts/status");
    expect((accountsInit.headers as Record<string, string>).Authorization).toBe("Bearer test-access");
  });
  it("model_toggle выкл/вкл сохраняет настройки; update/disconnect работают с выключенными", async () => {
    const { host, path } = await load();
    await host.harness.behavior.callRpc("provider_save", { id: "p", baseUrl: "http://localhost:4010/v1", api: "openai-completions" });
    await host.harness.behavior.callRpc("model_connect", { providerId: "p", modelId: "m1" });
    await host.harness.behavior.callRpc("model_update", { providerId: "p", modelId: "m1", patch: { reasoning: true, contextWindow: 400000 } });
    expect(await host.harness.behavior.callRpc("model_toggle", { providerId: "p", modelId: "m1", enabled: false })).toEqual({ enabled: false });
    let view = (await host.harness.behavior.callRpc("providers_list", null) as { providers: Array<{ models: Array<Record<string, unknown>>; disabled: Array<Record<string, unknown>> }> }).providers[0]!;
    expect(view.models).toEqual([]);
    expect(view.disabled[0]).toMatchObject({ id: "m1", reasoning: true, contextWindow: 400000 });
    expect(JSON.parse(await readFile(path, "utf8")).providers.p.models).toEqual([]);
    await host.harness.behavior.callRpc("model_update", { providerId: "p", modelId: "m1", patch: { maxTokens: 999 } });
    expect(await host.harness.behavior.callRpc("model_toggle", { providerId: "p", modelId: "m1", enabled: true })).toEqual({ enabled: true });
    view = (await host.harness.behavior.callRpc("providers_list", null) as { providers: Array<{ models: Array<Record<string, unknown>>; disabled: Array<Record<string, unknown>> }> }).providers[0]!;
    expect(view.disabled).toEqual([]);
    expect(view.models[0]).toMatchObject({ id: "m1", reasoning: true, contextWindow: 400000, maxTokens: 999 });
    await host.harness.behavior.callRpc("model_toggle", { providerId: "p", modelId: "m1", enabled: false });
    expect(await host.harness.behavior.callRpc("model_disconnect", { providerId: "p", modelId: "m1" })).toEqual({ removed: true });
    view = (await host.harness.behavior.callRpc("providers_list", null) as { providers: Array<{ models: Array<Record<string, unknown>>; disabled: Array<Record<string, unknown>> }> }).providers[0]!;
    expect(view.disabled).toEqual([]);
  });
  it("relay_accounts: label fallback когда email нет", async () => {
    const { host } = await load();
    await host.harness.behavior.callRpc("provider_save", { id: "p", baseUrl: "http://localhost:4010/v1", api: "openai-completions" });
    await host.harness.behavior.callRpc("relay_creds_set", { providerId: "p", username: "u", password: "p" });
    const session = { access_token: "test-access", expires_at: new Date(Date.now() + 3600_000).toISOString() };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(session), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ auth_index: "k1", provider: "kimi", quotas: [] }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ files: [{ name: "kimi-1.json", auth_index: "k1", label: "kimi" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const view = await host.harness.behavior.callRpc("relay_accounts", { providerId: "p" }) as { items: Array<{ label?: string; email?: string }> };
    expect(view.items[0]!.label).toBe("kimi");
    expect(view.items[0]!.email).toBeUndefined();
  });
  it("relay_accounts: health_status disabled без auth-files записи → disabled:true без тумблера", async () => {
    const { host } = await load();
    await host.harness.behavior.callRpc("provider_save", { id: "p", baseUrl: "http://localhost:4010/v1", api: "openai-completions" });
    await host.harness.behavior.callRpc("relay_creds_set", { providerId: "p", username: "u", password: "p" });
    const session = { access_token: "test-access", expires_at: new Date(Date.now() + 3600_000).toISOString() };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(session), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ auth_index: "shared1", health_status: "disabled", quotas: [] }, { auth_index: "own1", health_status: "ok", quotas: [] }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ files: [{ name: "own1.json", auth_index: "own1", disabled: false }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const view = await host.harness.behavior.callRpc("relay_accounts", { providerId: "p" }) as { items: Array<{ auth_index: string; disabled: boolean; auth_name?: string }> };
    expect(view.items[0]).toMatchObject({ auth_index: "shared1", disabled: true });
    expect(view.items[0]!.auth_name).toBeUndefined();
    expect(view.items[1]).toMatchObject({ auth_index: "own1", disabled: false, auth_name: "own1.json" });
  });
  it("relay_accounts мержит disabled/auth_name; relay_account_toggle патчит auth-files", async () => {
    const { host } = await load();
    await host.harness.behavior.callRpc("provider_save", { id: "p", baseUrl: "http://localhost:4010/v1", api: "openai-completions" });
    await host.harness.behavior.callRpc("relay_creds_set", { providerId: "p", username: "u", password: "p" });
    const session = { access_token: "test-access", expires_at: new Date(Date.now() + 3600_000).toISOString() };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(session), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ auth_index: "idx1", quotas: [] }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ files: [{ name: "f1.json", auth_index: "idx1", disabled: true, email: "u@example.com" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ files: [{ name: "f1.json", auth_index: "idx1", disabled: true, email: "u@example.com" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok", disabled: false }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const view = await host.harness.behavior.callRpc("relay_accounts", { providerId: "p" }) as { items: Array<{ auth_index: string; disabled: boolean; auth_name?: string }> };
    expect(view.items[0]).toMatchObject({ auth_index: "idx1", disabled: true, auth_name: "f1.json", email: "u@example.com" });
    const toggled = await host.harness.behavior.callRpc("relay_account_toggle", { providerId: "p", authIndex: "idx1", enabled: true }) as { disabled: boolean };
    expect(toggled).toEqual({ disabled: false });
    const patchCall = fetchMock.mock.calls[4] as unknown as [string, RequestInit];
    expect(patchCall[0]).toBe("http://localhost:4010/v0/management/auth-files/status");
    expect(patchCall[1].method).toBe("PATCH");
    expect(JSON.parse(String(patchCall[1].body))).toEqual({ name: "f1.json", disabled: false });
  });
  it("relay_creds_set per-origin: login с кредами адреса, clear → configured:false", async () => {
    const { host } = await load();
    await host.harness.behavior.callRpc("provider_save", { id: "p", baseUrl: "http://localhost:4010/v1", api: "openai-completions", apiKey: "test-key" });
    await host.harness.behavior.callRpc("relay_creds_set", { providerId: "p", username: "addr-user", password: "addr-pass" });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "test-access", expires_at: new Date(Date.now() + 3600_000).toISOString() }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await host.harness.behavior.callRpc("relay_accounts", { providerId: "p" }) as { configured: boolean };
    expect(result.configured).toBe(true);
    const [, loginInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(loginInit.body))).toMatchObject({ username: "addr-user", password: "addr-pass" });
    expect(JSON.stringify(result)).not.toContain("addr-pass");
    await host.harness.behavior.callRpc("relay_creds_clear", { providerId: "p" });
    const after = await host.harness.behavior.callRpc("relay_accounts", { providerId: "p" }) as { configured: boolean };
    expect(after.configured).toBe(false);
  });
  it("rings_state по умолчанию пуст, size 40, perRow 1", async () => {
    const { host } = await load();
    expect(await host.harness.behavior.callRpc("rings_state", null)).toEqual({ selected: [], size: 40, perRow: 1 });
  });
  it("rings_toggle добавляет и убирает ключ + реалтайм", async () => {
    const { host } = await load();
    expect(await host.harness.behavior.callRpc("rings_toggle", { key: "http://a:1|k1", on: true })).toEqual({
      selected: ["http://a:1|k1"], size: 40, perRow: 1,
    });
    expect(await host.harness.behavior.callRpc("rings_toggle", { key: "http://a:1|k1", on: true })).toEqual({
      selected: ["http://a:1|k1"], size: 40, perRow: 1,
    });
    expect(await host.harness.behavior.callRpc("rings_toggle", { key: "http://a:1|k2", on: true })).toEqual({
      selected: ["http://a:1|k1", "http://a:1|k2"], size: 40, perRow: 1,
    });
    expect(await host.harness.behavior.callRpc("rings_toggle", { key: "http://a:1|k1", on: false })).toEqual({
      selected: ["http://a:1|k2"], size: 40, perRow: 1,
    });
    expect(await host.harness.behavior.callRpc("rings_state", null)).toEqual({ selected: ["http://a:1|k2"], size: 40, perRow: 1 });
    expect(host.harness.inspection.realtimeSignals.filter((signal) => signal.channel === "relay-rings-changed")).toHaveLength(4);
  });
  it("rings_size клампит 24..64 и не даёт NaN на JSON-границе", async () => {
    const { host } = await load();
    expect(await host.harness.behavior.callRpc("rings_size", { size: 100 })).toEqual({ selected: [], size: 64, perRow: 1 });
    expect(await host.harness.behavior.callRpc("rings_size", { size: 10 })).toEqual({ selected: [], size: 24, perRow: 1 });
    expect(await host.harness.behavior.callRpc("rings_size", { size: 48 })).toEqual({ selected: [], size: 48, perRow: 1 });
    expect(host.harness.inspection.realtimeSignals.filter((signal) => signal.channel === "relay-rings-changed")).toHaveLength(3);
    await expect(host.harness.behavior.callRpc("rings_size", { size: "48" })).rejects.toThrow();
  });
  it("rings_per_row клампит 1..4, сохраняет выбор и публикует реалтайм", async () => {
    const { host } = await load();
    await host.harness.behavior.callRpc("rings_toggle", { key: "http://a:1|k1", on: true });
    expect(await host.harness.behavior.callRpc("rings_per_row", { perRow: 3 })).toEqual({
      selected: ["http://a:1|k1"], size: 40, perRow: 3,
    });
    expect(await host.harness.behavior.callRpc("rings_per_row", { perRow: 9 })).toEqual({
      selected: ["http://a:1|k1"], size: 40, perRow: 4,
    });
    expect(await host.harness.behavior.callRpc("rings_per_row", { perRow: 0 })).toEqual({
      selected: ["http://a:1|k1"], size: 40, perRow: 1,
    });
    expect(host.harness.inspection.realtimeSignals.filter((signal) => signal.channel === "relay-rings-changed")).toHaveLength(4);
    await expect(host.harness.behavior.callRpc("rings_per_row", { perRow: "2" })).rejects.toThrow();
  });
  it("rings_* не трогают models.json и переживают перезагрузку плагина", async () => {
    const { host, path } = await load(JSON.stringify({ providers: {} }));
    await host.harness.behavior.callRpc("provider_save", { id: "p", baseUrl: "http://localhost:4010/v1", api: "openai-completions" });
    const before = await readFile(path, "utf8");
    await host.harness.behavior.callRpc("rings_toggle", { key: "http://a:1|k1", on: true });
    await host.harness.behavior.callRpc("rings_size", { size: 33 });
    await host.harness.behavior.callRpc("rings_per_row", { perRow: 2 });
    expect(await readFile(path, "utf8")).toBe(before);
    const reloaded = await host.harness.lifecycle.reload((bb) => plugin(bb));
    hosts.push(reloaded);
    expect(await reloaded.harness.behavior.callRpc("rings_state", null)).toEqual({ selected: ["http://a:1|k1"], size: 33, perRow: 2 });
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

describe("токены в общем плагине", () => {
  it("регистрирует методы токенов рядом со своими; bench-методов нет", async () => {
    const { host } = await load();
    expect(await host.harness.behavior.callRpc("providers_list", null)).toEqual({ providers: [] });
    const display = await host.harness.behavior.callRpc("tokens_display_get", null) as Record<string, unknown>;
    expect(display).toMatchObject({ thread: { enabled: true }, badge: { enabled: true } });
    expect(await host.harness.behavior.callRpc("thread_usage", { threadId: "thr_1" })).toBeNull();
    expect(await host.harness.behavior.callRpc("turn_usage", { keys: ["thr_1:turn-1"] }))
      .toEqual({ "thr_1:turn-1": null });
    await expect(host.harness.behavior.callRpc("bench_list", null)).rejects.toThrow();
  });
});

describe("API-настройки модели", () => {
  const FILE = JSON.stringify({
    providers: {
      "router-gpt": {
        baseUrl: "http://localhost:4010/v1", api: "openai-completions", apiKey: "prov-key", authHeader: true,
        models: [{ id: "gpt-6.2-sol", apiKey: "model-key", headers: { "X-M": "model-secret" }, reasoning: true }],
      },
    },
  });
  it("model_update: новые поля пишутся в файл, ответ и providers_list без секретов", async () => {
    const { host, path } = await load(FILE);
    const patch = {
      thinkingLevelMap: { off: null, low: "low", high: "high" },
      samplingParams: { reasoning_effort: "high" },
      compat: { supportsDeveloperRole: false, supportsStore: false, promptCacheKeyMode: "disabled" },
      cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
      promptCache: { short: 300 }, inputLimits: { maxRequestBytes: 100 },
      api: "openai-completions", baseUrl: "http://localhost:4011/v1",
    };
    const updated = await host.harness.behavior.callRpc("model_update", { providerId: "router-gpt", modelId: "gpt-6.2-sol", patch });
    const dump = JSON.stringify(updated);
    for (const secret of ["model-key", "model-secret", "prov-key"]) expect(dump).not.toContain(secret);
    expect(updated).toMatchObject({ id: "gpt-6.2-sol", apiKeySet: true, headersSet: true, headerNames: ["X-M"] });
    const onDisk = JSON.parse(await readFile(path, "utf8")).providers["router-gpt"].models[0];
    expect(onDisk.samplingParams).toEqual({ reasoning_effort: "high" });
    expect(onDisk.compat.promptCacheKeyMode).toBe("disabled");
    expect(onDisk.apiKey).toBe("model-key"); // патч не трогал ключ
    expect(onDisk.headers).toEqual({ "X-M": "model-secret" });
    const { providers } = await host.harness.behavior.callRpc("providers_list", null) as { providers: Array<Record<string, unknown>> };
    expect(JSON.stringify(providers)).not.toContain("model-secret");
    expect(providers[0]).toMatchObject({ authHeader: true, headersSet: false });
  });
  it("ключ модели: установка и очистка через RPC", async () => {
    const { host, path } = await load(FILE);
    await host.harness.behavior.callRpc("model_update", { providerId: "router-gpt", modelId: "gpt-6.2-sol", patch: { apiKey: "new-model-key" } });
    expect(JSON.parse(await readFile(path, "utf8")).providers["router-gpt"].models[0].apiKey).toBe("new-model-key");
    const cleared = await host.harness.behavior.callRpc("model_update", { providerId: "router-gpt", modelId: "gpt-6.2-sol", patch: { apiKey: "" } }) as Record<string, unknown>;
    expect(cleared.apiKeySet).toBe(false);
    expect(JSON.stringify(cleared)).not.toContain("new-model-key");
    expect(JSON.parse(await readFile(path, "utf8")).providers["router-gpt"].models[0].apiKey).toBeUndefined();
  });
  it("headers модели: мерж сохраняет невидимые значения, \"\" удаляет, null очищает", async () => {
    const { host, path } = await load(FILE);
    await host.harness.behavior.callRpc("model_update", { providerId: "router-gpt", modelId: "gpt-6.2-sol", patch: { headers: { "X-New": "$ENV" } } });
    expect(JSON.parse(await readFile(path, "utf8")).providers["router-gpt"].models[0].headers).toEqual({ "X-M": "model-secret", "X-New": "$ENV" });
    await host.harness.behavior.callRpc("model_update", { providerId: "router-gpt", modelId: "gpt-6.2-sol", patch: { headers: { "X-M": "" } } });
    expect(JSON.parse(await readFile(path, "utf8")).providers["router-gpt"].models[0].headers).toEqual({ "X-New": "$ENV" });
    await host.harness.behavior.callRpc("model_update", { providerId: "router-gpt", modelId: "gpt-6.2-sol", patch: { headers: null } });
    expect(JSON.parse(await readFile(path, "utf8")).providers["router-gpt"].models[0].headers).toBeUndefined();
  });
  it("disabled-модель: патч применяется, секреты не утекают через providers_list", async () => {
    const { host } = await load(FILE);
    await host.harness.behavior.callRpc("model_toggle", { providerId: "router-gpt", modelId: "gpt-6.2-sol", enabled: false });
    const updated = await host.harness.behavior.callRpc("model_update", { providerId: "router-gpt", modelId: "gpt-6.2-sol", patch: { samplingParams: { temperature: 0.5 }, apiKey: "" } });
    expect(updated).toMatchObject({ id: "gpt-6.2-sol", apiKeySet: false });
    expect(JSON.stringify(updated)).not.toContain("model-secret");
    const { providers } = await host.harness.behavior.callRpc("providers_list", null) as { providers: Array<{ disabled: Array<Record<string, unknown>> }> };
    expect(providers[0]!.disabled[0]).toMatchObject({ samplingParams: { temperature: 0.5 }, apiKeySet: false, headerNames: ["X-M"] });
    expect(JSON.stringify(providers)).not.toContain("model-secret");
    expect(JSON.stringify(providers)).not.toContain("model-key");
  });
  it("невалидные JSON-поля отклоняются контрактом, файл не меняется", async () => {
    const { host, path } = await load(FILE);
    const before = await readFile(path, "utf8");
    await expect(host.harness.behavior.callRpc("model_update", { providerId: "router-gpt", modelId: "gpt-6.2-sol", patch: { compat: { supportsStore: "false" } } })).rejects.toThrow();
    await expect(host.harness.behavior.callRpc("model_update", { providerId: "router-gpt", modelId: "gpt-6.2-sol", patch: { cost: { input: 1 } } })).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(before);
  });
  it("старый патч из пяти полей работает как раньше", async () => {
    const { host, path } = await load(FILE);
    await host.harness.behavior.callRpc("model_update", { providerId: "router-gpt", modelId: "gpt-6.2-sol", patch: { name: "Sol", contextWindow: 500000, maxTokens: null } });
    const model = JSON.parse(await readFile(path, "utf8")).providers["router-gpt"].models[0];
    expect(model.name).toBe("Sol");
    expect(model.contextWindow).toBe(500000);
    expect(model.maxTokens).toBeUndefined();
  });
});

describe("API-настройки провайдера", () => {
  it("provider_save: authHeader/oauth/compat/headers roundtrip, null удаляет, секреты не в ответе", async () => {
    const { host, path } = await load();
    const saved = await host.harness.behavior.callRpc("provider_save", {
      id: "p", baseUrl: "http://localhost:4010/v1", api: "openai-completions", apiKey: "prov-key",
      authHeader: true, oauth: "radius", compat: { supportsStore: false }, headers: { "X-P": "prov-secret" },
    }) as Record<string, unknown>;
    expect(saved).toMatchObject({ authHeader: true, oauth: "radius", compat: { supportsStore: false }, headersSet: true, headerNames: ["X-P"] });
    expect(JSON.stringify(saved)).not.toContain("prov-secret");
    expect(JSON.stringify(saved)).not.toContain("prov-key");
    const onDisk = JSON.parse(await readFile(path, "utf8")).providers.p;
    expect(onDisk.headers).toEqual({ "X-P": "prov-secret" });
    await host.harness.behavior.callRpc("provider_save", { id: "p", baseUrl: "http://localhost:4010/v1", api: "openai-completions", headers: { "X-Q": "v2" } });
    expect(JSON.parse(await readFile(path, "utf8")).providers.p.headers).toEqual({ "X-P": "prov-secret", "X-Q": "v2" });
    const cleared = await host.harness.behavior.callRpc("provider_save", { id: "p", baseUrl: "http://localhost:4010/v1", api: "openai-completions", authHeader: null, oauth: null, compat: null, headers: null }) as Record<string, unknown>;
    expect(cleared.headersSet).toBe(false);
    expect(cleared.authHeader).toBeUndefined();
    const final = JSON.parse(await readFile(path, "utf8")).providers.p;
    expect(final.headers).toBeUndefined();
    expect(final.compat).toBeUndefined();
    expect(final.apiKey).toBe("prov-key");
  });
  it("невалидный compat провайдера отклоняется", async () => {
    const { host } = await load();
    await expect(host.harness.behavior.callRpc("provider_save", { id: "p", baseUrl: "http://localhost:4010/v1", api: "openai-completions", compat: { promptCacheKeyMode: "wrong" } })).rejects.toThrow();
 });
});
