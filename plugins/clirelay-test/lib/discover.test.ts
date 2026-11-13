import { describe, expect, it } from "vitest";
import { DiscoverError, discoverModels, resolveApiKey } from "./discover";

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
