import { describe, expect, it, vi } from "vitest";
import { DiscoverError } from "./discover";
import { fetchRelayAccounts, relayOrigin, successPercent } from "./relay-accounts";

const SNAPSHOT = {
  items: [
    {
      auth_index: "claude:user@example.com",
      provider: "claude",
      plan_type: "pro",
      restriction_summary: "restricted",
      quotas: [
        { quota_key: "5h", quota_label: "5-hour limit", percent: 100, reset_at: "2026-11-14T05:00:00Z", window_seconds: 18000 },
        { quota_key: "7d-fable", quota_label: "7-day Fable", percent: 13, reset_at: "2026-11-17T00:00:00Z" },
      ],
      usage: { success_rate: 98.9, request_total: 900, cost_total: 26.3 },
    },
  ],
};

const ok = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200 });

describe("relayOrigin", () => {
  it("срезает /v1 и хвостовые слэши", () => {
    expect(relayOrigin("http://localhost:4010/v1/")).toBe("http://localhost:4010");
    expect(relayOrigin("http://localhost:4010")).toBe("http://localhost:4010");
  });
});

describe("successPercent", () => {
  it("доля 0..1 → проценты, уже проценты не трогаем", () => {
    expect(successPercent(0.989)).toBeCloseTo(98.9);
    expect(successPercent(1)).toBe(100);
    expect(successPercent(0)).toBe(0);
    expect(successPercent(98.9)).toBe(98.9);
    expect(successPercent(undefined)).toBeUndefined();
  });
});

describe("fetchRelayAccounts", () => {
  it("ходит с Bearer managementKey и парсит квоты", async () => {
    const fetchImpl = vi.fn(ok(SNAPSHOT));
    const items = await fetchRelayAccounts("http://localhost:4010/v1", "test-mgmt", fetchImpl);
    expect(items).toHaveLength(1);
    expect(items[0]!.auth_index).toBe("claude:user@example.com");
    expect(items[0]!.quotas[1]!.percent).toBe(13);
    expect(items[0]!.usage?.success_rate).toBe(98.9);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:4010/v0/management/ai-accounts/status");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-mgmt");
  });
  it("401/403 → понятная ошибка без URL", async () => {
    for (const status of [401, 403]) {
      const fail = async () => new Response(JSON.stringify({ error: "invalid management key" }), { status });
      const error = await fetchRelayAccounts("http://localhost:4010/v1", "bad", fail).then(
        () => { throw new Error("ожидалась ошибка"); },
        (cause: Error) => cause,
      );
      expect(error).toBeInstanceOf(DiscoverError);
      expect(error.message).toContain("логин и пароль");
      expect(error.message).not.toContain("localhost");
    }
  });
  it("пустой snapshot и битая форма", async () => {
    expect(await fetchRelayAccounts("http://localhost:4010/v1", "test-mgmt", ok({}))).toEqual([]);
    await expect(fetchRelayAccounts("http://localhost:4010/v1", "test-mgmt", ok({ items: "nope" }))).rejects.toThrow(/формат/);
    const html = async () => new Response("<html>", { status: 200 });
    await expect(fetchRelayAccounts("http://localhost:4010/v1", "test-mgmt", html)).rejects.toThrow(/не JSON/);
  });
});
