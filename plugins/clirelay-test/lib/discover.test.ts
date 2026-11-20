import { describe, expect, it, vi } from "vitest";
import { DiscoverError, discoverModelDetails, discoverModels, resolveApiKey, testModel } from "./discover";

const ok = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200 });

describe("resolveApiKey", () => {
  it("literal и $ENV", () => {
    expect(resolveApiKey("test-key")).toBe("test-key");
    expect(resolveApiKey("$TEST_KEY", { TEST_KEY: "env-key" })).toBe("env-key");
    expect(resolveApiKey("${TEST_KEY}", { TEST_KEY: "env-key" })).toBe("env-key");
    expect(resolveApiKey(undefined)).toBeUndefined();
  });
  it("missing env и !command → ошибка без значения", () => {
    expect(() => resolveApiKey("$MISSING_KEY", {})).toThrow(/не задана/);
    expect(() => resolveApiKey("!cat /secret")).toThrow(/не поддерживается/);
  });
});

describe("discoverModels", () => {
  it("парсит data, сортирует, дедуплицирует", async () => {
    const fetchImpl = ok({ data: [{ id: "b" }, { id: "a" }, { id: "b" }] });
    expect(await discoverModels("http://localhost:4010/v1", "test-key", fetchImpl)).toEqual(["a", "b"]);
  });
  it("принимает плоский массив", async () => {
    expect(await discoverModels("http://localhost:4010/v1", undefined, ok(["x", { id: "y" }]))).toEqual(["x", "y"]);
  });
  it("HTTP-ошибка санитизируется (без URL)", async () => {
    const fail = async () => new Response("no", { status: 404 });
    const error = await discoverModels("http://localhost:4010/v1", undefined, fail).then(
      () => { throw new Error("ожидалась ошибка"); },
      (cause: Error) => cause,
    );
    expect(error).toBeInstanceOf(DiscoverError);
    expect(error.message).toContain("404");
    expect(error.message).not.toContain("localhost");
  });
  it("сетевой сбой санитизируется", async () => {
    const boom = async () => { throw new Error("connect ECONNREFUSED http://localhost:4010"); };
    const error = await discoverModels("http://localhost:4010/v1", undefined, boom).then(
      () => { throw new Error("ожидалась ошибка"); },
      (cause: Error) => cause,
    );
    expect(error).toBeInstanceOf(DiscoverError);
    expect(error.message).not.toContain("localhost");
  });
  it("не-JSON и пустой ответ → ошибка", async () => {
    const html = async () => new Response("<html>", { status: 200 });
    await expect(discoverModels("http://localhost:4010/v1", undefined, html)).rejects.toThrow(/не JSON/);
    await expect(discoverModels("http://localhost:4010/v1", undefined, ok({}))).rejects.toThrow(/нет списка/);
  });
});

describe("discoverModelDetails", () => {
  const details = (body: unknown) => discoverModelDetails("http://localhost:4010/v1", undefined, ok(body));

  it("id sorted/deduped + только whitelist metadata", async () => {
    const result = await details({
      data: [
        { id: "b", context_window: 200000, max_tokens: 8192, input_modalities: ["text", "image", "audio"], supported_reasoning_levels: ["low", "high"], pricing: { input: 1 }, description: "d", secret: "leak" },
        { id: "a" },
        { id: "b" },
      ],
    });
    expect(result.map((model) => model.id)).toEqual(["a", "b"]);
    expect(result[1]).toEqual({
      id: "b", contextWindow: 200000, maxTokens: 8192,
      input: ["text", "image"], supportedReasoningLevels: ["low", "high"],
    });
    const json = JSON.stringify(result);
    expect(json).not.toContain("pricing");
    expect(json).not.toContain("leak");
  });
  const byId = async (body: unknown) => new Map((await details(body)).map((model) => [model.id, model]));

  it("alias-пары: одно валидное → использовать, равные → использовать, разные → unreliable", async () => {
    const map = await byId({
      data: [
        { id: "one", max_context_window: 100000, max_output_tokens: 4096 },
        { id: "equal", context_window: 100000, max_context_window: 100000, max_tokens: 4096, max_output_tokens: 4096 },
        { id: "differ", context_window: 100000, max_context_window: 200000, max_tokens: 4096, max_output_tokens: 8192 },
        { id: "swapped", context_window: 100000, max_context_window: "200000" },
      ],
    });
    expect(map.get("one")).toEqual({ id: "one", contextWindow: 100000, maxTokens: 4096 });
    expect(map.get("equal")).toEqual({ id: "equal", contextWindow: 100000, maxTokens: 4096 });
    expect(map.get("differ")).toEqual({ id: "differ" });
    expect(map.get("swapped")).toEqual({ id: "swapped", contextWindow: 100000 });
  });
  it("числа: строки, float, 0, negative, overflow отклоняются", async () => {
    const result = await details({
      data: [
        { id: "s", context_window: "128000", max_tokens: "16384" },
        { id: "f", context_window: 128000.5, max_tokens: 16384.25 },
        { id: "z", context_window: 0, max_tokens: 0 },
        { id: "n", context_window: -1, max_tokens: -5 },
        { id: "big", context_window: 10_000_001, max_tokens: 1_000_001 },
        { id: "edge", context_window: 10_000_000, max_tokens: 1_000_000 },
        { id: "nan", context_window: Number.NaN, max_tokens: Number.POSITIVE_INFINITY },
      ],
    });
    expect(result).toEqual([
      { id: "big" }, { id: "edge", contextWindow: 10_000_000, maxTokens: 1_000_000 },
      { id: "f" }, { id: "n" }, { id: "nan" }, { id: "s" }, { id: "z" },
    ]);
  });
  it("input_modalities: только text/image, dedupe, пусто → поля нет", async () => {
    const map = await byId({
      data: [
        { id: "deduped", input_modalities: ["image", "text", "image"] },
        { id: "empty", input_modalities: ["audio", "video"] },
        { id: "wrongType", input_modalities: "text" },
      ],
    });
    expect(map.get("deduped")!.input).toEqual(["image", "text"]);
    expect(map.get("empty")).toEqual({ id: "empty" });
    expect(map.get("wrongType")).toEqual({ id: "wrongType" });
  });
  it("supported_reasoning_levels: all-valid → как есть, иначе поле целиком игнорируется", async () => {
    const map = await byId({
      data: [
        { id: "ok", supported_reasoning_levels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] },
        { id: "bad", supported_reasoning_levels: ["low", "turbo"] },
        { id: "empty", supported_reasoning_levels: [] },
      ],
    });
    expect(map.get("ok")!.supportedReasoningLevels).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(map.get("bad")).toEqual({ id: "bad" });
    expect(map.get("empty")).toEqual({ id: "empty", supportedReasoningLevels: [] });
  });
  it("discoverModels остаётся проекцией id (старый контракт)", async () => {
    const body = { data: [{ id: "a", context_window: 1 }] };
    expect(await discoverModels("http://localhost:4010/v1", undefined, ok(body))).toEqual(["a"]);
  });
});

describe("testModel", () => {
  it("шлёт минимальный chat-запрос и возвращает ответ с латентностью", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200 }));
    const result = await testModel("http://localhost:4010/v1", "test-key", "m1", fetchImpl);
    expect(result.ok).toBe(true);
    expect(result.detail).toBe("OK");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:4010/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.model).toBe("m1");
    expect(body.stream).toBe(false);
    expect(body.max_tokens).toBeLessThanOrEqual(16);
  });
  it("HTTP-ошибка: ok=false, статус и сообщение без URL", async () => {
    const fail = async () => new Response(JSON.stringify({ error: { message: "model not found at http://localhost:4010/v1" } }), { status: 404 });
    const result = await testModel("http://localhost:4010/v1", undefined, "m1", fail);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("404");
    expect(result.detail).toContain("model not found");
    expect(result.detail).not.toContain("localhost");
  });
  it("сетевой сбой и таймаут санитизируются", async () => {
    const boom = async () => { throw new Error("ECONNREFUSED http://localhost:4010"); };
    expect((await testModel("http://localhost:4010/v1", undefined, "m1", boom)).detail).not.toContain("localhost");
    const abort = async () => { const error = new Error("aborted"); error.name = "AbortError"; throw error; };
    expect((await testModel("http://localhost:4010/v1", undefined, "m1", abort)).detail).toContain("таймаут");
  });
});
