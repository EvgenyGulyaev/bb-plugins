import { describe, expect, it, vi } from "vitest";
import { DiscoverError, discoverModels, resolveApiKey, testModel } from "./discover";

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
