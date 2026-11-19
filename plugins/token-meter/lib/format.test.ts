import { afterEach, describe, expect, it } from "vitest";
import { formatBenchDate, formatCompact, formatThreadText, formatTurnText, formatTurnTitle } from "./format.js";

const originalTz = process.env.TZ;

afterEach(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

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
    expect(formatTurnText({ input: 1_200, cached: 0, output: 740, tokPerSec: 42 })).toBe("↑1.2k ↓740 · cache 0 · 42 ток/с (эфф.)");
  });

  it("округляет эффективную скорость и добавляет прямой замер модели", () => {
    expect(formatTurnText({ input: 1, cached: 0, output: 2, tokPerSec: 134.4 })).toContain("134 ток/с (эфф.)");
    expect(formatTurnText({ input: 1, cached: 0, output: 2, tokPerSec: 99.95 })).toContain("100 ток/с (эфф.)");
    expect(formatTurnText({ input: 1, cached: 0, output: 2, tokPerSec: 9.95 })).toContain("10 ток/с (эфф.)");
    expect(formatTurnText(
      { input: 1, cached: 0, output: 2, tokPerSec: 134.4 },
      { model: "test-model", genTokPerSec: 207.2, latencyMs: 1_000, at: 1, samples: [] },
    )).toBe("↑1 ↓2 · cache 0 · 134 ток/с (эфф.) · модель ~207");
  });

  it("показывает сумму треда и среднюю эффективную скорость только при наличии", () => {
    expect(formatThreadText({ total: 531_000 })).toBe("Σ 531k токенов");
    expect(formatThreadText({ total: 531_000, averageTokPerSec: 40 })).toBe("Σ 531k токенов · ~40 ток/с (эфф.)");
  });

  it("объясняет эффективную скорость и показывает длительности и замер", () => {
    const title = formatTurnTitle({
      threadId: "thr_1", turnId: "turn-1", input: 1_200, cached: 265_000,
      cacheRead: 260_000, cacheWrite: 5_000, output: 740, reasoning: 120,
      total: 2_060, durationMs: 12_500, turnDurationMs: 20_000, tokPerSec: 59.2,
      model: "test-model", providerId: "test-provider", at: 1_000,
    }, {
      model: "test-model", genTokPerSec: 207.2, latencyMs: 1_040,
      at: Date.UTC(2026, 0, 2, 12), samples: [],
    });
    expect(title).toContain("Эффективная скорость последнего вызова: 59.2 ток/с — выход ÷ время от конца последнего инструмента до конца хода; включает ожидание первого токена (обработка контекста, очередь, скрытое рассуждение)");
    expect(title).toContain("Последний вызов: 12.5 с · Весь ход: 20 с");
    expect(title).toContain("Чистая генерация модели test-model: ~207 ток/с, задержка ~1.0 с (замер 2026-01-02)");
  });
});

describe("дата замера", () => {
  it.each([
    ["Asia/Tokyo", Date.UTC(2025, 11, 31, 20), "2026-01-01"],
    ["America/Los_Angeles", Date.UTC(2026, 0, 3, 2), "2026-01-02"],
  ])("%s → локальная дата %s", (timeZone, at, expected) => {
    process.env.TZ = timeZone;
    expect(formatBenchDate(at)).toBe(expected);
  });
});
