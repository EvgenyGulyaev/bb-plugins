import { describe, expect, it, vi } from "vitest";
import { DiscoverError } from "./discover";
import { fetchUsageSummary, relayOrigin } from "./usage";

const FULL = {
  found: true,
  range: "today",
  stats: { total_calls: 64, quota_cost: 0.001 },
  limits: { "daily-spending-limit": 10, "daily-spending-used": 1.25, "total-quota": 100, "total-used": 683 },
  "quota-scopes": [
    {
      scope: "key",
      "period-spending": [{ period: "5h", limit: 5, used: 1, remaining: 4, window_start: "2026-11-14T00:00:00Z", resets_at: "2026-11-14T05:00:00Z" }],
      "daily-spending-used": 0.001,
      "lifetime-spending-used": 683.15,
    },
  ],
};

const ok = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200 });

describe("relayOrigin", () => {
  it("срезает /v1 и хвостовые слэши", () => {
    expect(relayOrigin("http://localhost:4010/v1")).toBe("http://localhost:4010");
    expect(relayOrigin("http://localhost:4010/v1/")).toBe("http://localhost:4010");
    expect(relayOrigin("http://localhost:4010")).toBe("http://localhost:4010");
  });
});

describe("fetchUsageSummary", () => {
  it("шлёт POST с api_key и парсит лимиты/окна", async () => {
    const fetchImpl = vi.fn(ok(FULL));
    const summary = await fetchUsageSummary("http://localhost:4010/v1", "test-key", fetchImpl);
    expect(summary.found).toBe(true);
    expect(summary.limits?.["daily-spending-limit"]).toBe(10);
    expect(summary["quota-scopes"][0]!["period-spending"][0]!.remaining).toBe(4);
    expect(summary["quota-scopes"][0]!["period-spending"][0]!.resets_at).toBe("2026-11-14T05:00:00Z");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:4010/v0/management/public/usage/summary");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ api_key: "test-key" });
  });
  it("пустые limits и scopes → дефолты", async () => {
    const summary = await fetchUsageSummary("http://localhost:4010/v1", "test-key", ok({ found: true, range: "today", stats: { total_calls: 0, quota_cost: 0 }, limits: null }));
    expect(summary.limits).toBeNull();
    expect(summary["quota-scopes"]).toEqual([]);
  });
  it("HTTP-ошибка и сетевой сбой санитизируются", async () => {
    const fail = async () => new Response("no", { status: 401 });
    const error = await fetchUsageSummary("http://localhost:4010/v1", "test-key", fail).then(
      () => { throw new Error("ожидалась ошибка"); },
      (cause: Error) => cause,
    );
    expect(error).toBeInstanceOf(DiscoverError);
    expect(error.message).toContain("401");
    expect(error.message).not.toContain("localhost");
    const boom = async () => { throw new Error("ECONNREFUSED http://localhost:4010"); };
    const error2 = await fetchUsageSummary("http://localhost:4010/v1", "test-key", boom).then(
      () => { throw new Error("ожидалась ошибка"); },
      (cause: Error) => cause,
    );
    expect(error2.message).not.toContain("localhost");
  });
  it("не-JSON и битая форма → ошибка", async () => {
    const html = async () => new Response("<html>", { status: 200 });
    await expect(fetchUsageSummary("http://localhost:4010/v1", "test-key", html)).rejects.toThrow(/не JSON/);
    await expect(fetchUsageSummary("http://localhost:4010/v1", "test-key", ok({ nope: 1 }))).rejects.toThrow(/формат/);
  });
});
