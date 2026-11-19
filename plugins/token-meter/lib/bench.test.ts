import { afterEach, describe, expect, it, vi } from "vitest";
import { benchmarkModel } from "./bench.js";

function completionResponse(outputTokens: number, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ usage: { completion_tokens: outputTokens } }),
  } as Response;
}

function mockDeterministicFetch(
  calls: Array<{ outputTokens: number; durationMs: number; status?: number }>,
) {
  let now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const fetchMock = vi.fn(async (_url: unknown, _init?: unknown) => {
    const call = calls[fetchMock.mock.calls.length - 1];
    if (!call) throw new Error("unexpected fetch");
    now += call.durationMs;
    return completionResponse(call.outputTokens, call.status);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("benchmarkModel", () => {
  it("делает 150,1500,150,1500 non-stream и считает rate/latency по двум парам", async () => {
    const fetchMock = mockDeterministicFetch([
      { outputTokens: 100, durationMs: 1_000 },
      { outputTokens: 1_000, durationMs: 6_000 },
      { outputTokens: 100, durationMs: 1_000 },
      { outputTokens: 1_000, durationMs: 6_000 },
    ]);
    const result = await benchmarkModel({
      model: "test-model",
      endpoint: "http://localhost:8317/v1/",
      apiKey: "super-secret",
    });
    expect(result).toMatchObject({
      model: "test-model", genTokPerSec: 180, latencyMs: 444, at: 14_000,
    });
    expect(result.samples).toEqual([
      { maxTokens: 150, outputTokens: 100, durationMs: 1_000 },
      { maxTokens: 1_500, outputTokens: 1_000, durationMs: 6_000 },
      { maxTokens: 150, outputTokens: 100, durationMs: 1_000 },
      { maxTokens: 1_500, outputTokens: 1_000, durationMs: 6_000 },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (const [index, call] of fetchMock.mock.calls.entries()) {
      expect(call[0]).toBe("http://localhost:8317/v1/chat/completions");
      const init = call[1] as RequestInit;
      const body = JSON.parse(String(init.body));
      expect(body).toMatchObject({
        model: "test-model", max_tokens: index % 2 === 0 ? 150 : 1_500, stream: false,
        messages: [{ role: "user", content: "Перечисли через запятую числа от 1 до 2000 словами. Без вступления." }],
      });
      expect(init.method).toBe("POST");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.headers).toMatchObject({ Authorization: "Bearer super-secret" });
    }
    expect(JSON.stringify(result)).not.toContain("super-secret");
  });

  it("rate<=0 → понятная ошибка нестабильного замера", async () => {
    mockDeterministicFetch([
      { outputTokens: 100, durationMs: 1_000 },
      { outputTokens: 100, durationMs: 6_000 },
      { outputTokens: 100, durationMs: 1_000 },
      { outputTokens: 100, durationMs: 6_000 },
    ]);
    await expect(benchmarkModel({ model: "test-model", endpoint: "http://localhost:8317/v1" }))
      .rejects.toThrow("замер неустойчив");
  });

  it("HTTP и невалидный usage → понятные ошибки без тела ответа", async () => {
    mockDeterministicFetch([{ outputTokens: 100, durationMs: 1_000, status: 401 }]);
    await expect(benchmarkModel({ model: "test-model", endpoint: "http://localhost:8317/v1" }))
      .rejects.toThrow("HTTP 401");
  });

  it("таймаут → сообщение про 120 секунд", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new DOMException("timed out", "TimeoutError");
    }));
    await expect(benchmarkModel({ model: "test-model", endpoint: "http://localhost:8317/v1" }))
      .rejects.toThrow("таймаут 120 с");
  });
});
