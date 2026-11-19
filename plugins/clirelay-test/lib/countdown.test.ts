import { describe, expect, it } from "vitest";
import { formatWindowDuration, quotaResetFallback } from "./countdown";

describe("formatWindowDuration", () => {
  it("formats relay windows in Russian", () => {
    expect(formatWindowDuration(18000)).toBe("5 ч");
    expect(formatWindowDuration(604800)).toBe("7 дн");
  });

  it("rejects missing, invalid and non-positive durations", () => {
    expect(formatWindowDuration(undefined)).toBeNull();
    expect(formatWindowDuration(null)).toBeNull();
    expect(formatWindowDuration(0)).toBeNull();
    expect(formatWindowDuration(Number.NaN)).toBeNull();
  });
});

describe("quotaResetFallback", () => {
  it("distinguishes an unstarted window from an unknown reset", () => {
    expect(quotaResetFallback({ percent: 100, window_seconds: 18000 })).toEqual({
      text: "окно не начато",
      title: "relay не сообщает сброс, пока окно не начато; длина окна 5 ч",
    });
    expect(quotaResetFallback({ percent: 63, window_seconds: 18000 })).toEqual({
      text: "сброс неизвестен",
      title: "relay не сообщает сброс, пока окно не начато; длина окна 5 ч",
    });
  });

  it("does not replace an explicitly supplied reset", () => {
    expect(quotaResetFallback({ percent: 100, reset_at: "2030-01-01T00:00:00Z", window_seconds: 18000 })).toBeNull();
    expect(quotaResetFallback({ percent: 100 })).toBeNull();
  });
});
