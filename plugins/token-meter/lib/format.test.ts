import { describe, expect, it } from "vitest";
import { formatCompact, formatThreadText, formatTurnText } from "./format.js";

describe("formatCompact", () => {
  it.each([
    [0, "0"], [999, "999"], [1_000, "1k"], [1_200, "1.2k"],
    [265_000, "265k"], [1_200_000, "1.2M"], [999_999, "1M"],
  ])("%i → %s", (value, expected) => {
    expect(formatCompact(value)).toBe(expected);
  });
});

describe("текст бейджей", () => {
  it("показывает usage и опускает отсутствующую скорость", () => {
    expect(formatTurnText({ input: 1_200, cached: 265_000, output: 740 })).toBe("↑1.2k ↓740 · cache 265k");
    expect(formatTurnText({ input: 1_200, cached: 0, output: 740, tokPerSec: 42 })).toBe("↑1.2k ↓740 · cache 0 · 42 ток/с");
  });

  it("показывает сумму треда и среднюю скорость только при наличии", () => {
    expect(formatThreadText({ total: 531_000 })).toBe("Σ 531k токенов");
    expect(formatThreadText({ total: 531_000, averageTokPerSec: 40 })).toBe("Σ 531k токенов · ~40 ток/с");
  });
});
