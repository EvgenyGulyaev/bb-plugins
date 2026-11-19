import { describe, expect, it } from "vitest";
import type { TurnUsage } from "./contract.js";
import { usageEventRowSchema, turnEventRowSchema } from "./contract.js";
import { makeTurnUsage, retainTurns, summarizeTurns } from "./usage.js";

const tokenUsage = {
  last: {
    inputTokens: 1_200,
    cachedInputTokens: 265_000,
    cacheReadInputTokens: 260_000,
    cacheWriteInputTokens: 5_000,
    outputTokens: 42,
    reasoningOutputTokens: 7,
    totalTokens: 1_249,
  },
  total: {
    inputTokens: 5_000,
    cachedInputTokens: 300_000,
    outputTokens: 200,
    reasoningOutputTokens: 20,
    totalTokens: 531_000,
  },
  modelContextWindow: 1_000_000,
};

function usageRow() {
  return {
    id: "event-1",
    type: "thread/tokenUsage/updated",
    threadId: "thr_1",
    scope: { kind: "turn", turnId: "turn-1" },
    seq: 12,
    createdAt: 10_000,
    data: { tokenUsage: structuredClone(tokenUsage) },
  };
}

function turn(turnId: string, at: number, tokPerSec?: number): TurnUsage {
  return {
    threadId: "thr_1", turnId, input: 10, cached: 0, output: 5,
    reasoning: 0, total: 15, durationMs: 1_000, at,
    ...(tokPerSec === undefined ? {} : { tokPerSec }),
  };
}

describe("usageEventRowSchema", () => {
  it("берёт turnId из turn-скоупа события", () => {
    const parsed = usageEventRowSchema.safeParse(usageRow());
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.turnId).toBe("turn-1");
  });

  it("принимает верхнеуровневый turnId для совместимости", () => {
    const { scope: _scope, ...legacy } = usageRow();
    const parsed = usageEventRowSchema.safeParse({ ...legacy, turnId: "turn-2" });
    expect(parsed.success && parsed.data.turnId).toBe("turn-2");
  });

  it("отклоняет thread-скоуп и отсутствие turnId без throw", () => {
    const threadScoped = { ...usageRow(), scope: { kind: "thread" } };
    expect(() => usageEventRowSchema.safeParse(threadScoped)).not.toThrow();
    expect(usageEventRowSchema.safeParse(threadScoped).success).toBe(false);
    const { scope: _scope, ...noTurn } = usageRow();
    expect(usageEventRowSchema.safeParse(noTurn).success).toBe(false);
  });

  it("turn/started и turn/completed читают turnId из скоупа", () => {
    for (const type of ["turn/started", "turn/completed"] as const) {
      const parsed = turnEventRowSchema.safeParse({
        id: "event-2", type, threadId: "thr_1", scope: { kind: "turn", turnId: "turn-1" },
        seq: 13, createdAt: 10_000, data: { providerThreadId: "provider-thread" },
      });
      expect(parsed.success && [parsed.data.type, parsed.data.turnId]).toEqual([type, "turn-1"]);
    }
  });

  it("принимает фактический usage и optional cache read/write", () => {
    const parsed = usageEventRowSchema.safeParse(usageRow());
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.data.tokenUsage.last.cacheReadInputTokens).toBe(260_000);
  });

  it.each(["outputTokens", "totalTokens", "cachedInputTokens"])("отклоняет неполный usage без throw: %s", (field) => {
    const row = usageRow();
    delete (row.data.tokenUsage.last as Record<string, unknown>)[field];
    expect(() => usageEventRowSchema.safeParse(row)).not.toThrow();
    expect(usageEventRowSchema.safeParse(row).success).toBe(false);
  });
});

describe("makeTurnUsage", () => {
  it("durationMs = completed − started; tokPerSec округляется до 0.1", () => {
    expect(makeTurnUsage({ threadId: "thr_1", turnId: "turn-1", tokenUsage, startedAt: 7_000, completedAt: 10_000, at: 10_000 })).toMatchObject({
      input: 1_200, cached: 265_000, cacheRead: 260_000, cacheWrite: 5_000,
      output: 42, reasoning: 7, total: 1_249, durationMs: 3_000, tokPerSec: 14,
    });
  });

  it("не выдумывает скорость при duration < 1s, нулевом output или некорректном started", () => {
    expect(makeTurnUsage({ threadId: "thr_1", turnId: "turn-1", tokenUsage, startedAt: 9_001, completedAt: 10_000, at: 10_000 })).not.toHaveProperty("tokPerSec");
    expect(makeTurnUsage({ threadId: "thr_1", turnId: "turn-1", tokenUsage, startedAt: 11_000, completedAt: 10_000, at: 10_000 }).durationMs).toBeNull();
    const zero = structuredClone(tokenUsage);
    zero.last.outputTokens = 0;
    expect(makeTurnUsage({ threadId: "thr_1", turnId: "turn-1", tokenUsage: zero, startedAt: 0, completedAt: 2_000, at: 2_000 })).not.toHaveProperty("tokPerSec");
  });
});

describe("сводка и retention", () => {
  it("использует provider total и среднее только по ходам со скоростью", () => {
    expect(summarizeTurns("thr_1", [turn("a", 1, 30), turn("b", 2), turn("c", 3, 50)], 531_000, 1_000_000)).toEqual({
      threadId: "thr_1", total: 531_000, turns: 3, averageTokPerSec: 40, modelContextWindow: 1_000_000,
    });
  });

  it("оставляет не больше 500 новых ходов и вытесняет старые", () => {
    const result = retainTurns(Array.from({ length: 501 }, (_, i) => turn(String(i), i)), 1_000);
    expect(result.kept).toHaveLength(500);
    expect(result.kept.some((row) => row.turnId === "0")).toBe(false);
    expect(result.removed.map((row) => row.turnId)).toEqual(["0"]);
  });

  it("на старте удаляет записи старше 30 дней, границу сохраняет", () => {
    const now = 40 * 24 * 60 * 60 * 1000;
    const cutoff = now - 30 * 24 * 60 * 60 * 1000;
    const result = retainTurns([turn("old", cutoff - 1), turn("edge", cutoff), turn("new", now)], now);
    expect(result.kept.map((row) => row.turnId)).toEqual(["new", "edge"]);
    expect(result.removed.map((row) => row.turnId)).toEqual(["old"]);
  });
});
