import { describe, expect, it } from "vitest";
import type { TurnUsage } from "./contract.js";
import { itemEventRowSchema, turnEventRowSchema, turnUsageSchema, usageEventRowSchema } from "./contract.js";
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

function windowOf(patch: { windowStartedAt?: number | null; endedAt: number; turnStartedAt?: number | null }) {
  return makeTurnUsage({
    threadId: "thr_1",
    turnId: "turn-1",
    tokenUsage,
    windowStartedAt: patch.windowStartedAt,
    endedAt: patch.endedAt,
    turnStartedAt: patch.turnStartedAt ?? null,
    at: patch.endedAt,
  });
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

  it("item/started и item/completed читают turnId из скоупа и вид айтема", () => {
    const tool = itemEventRowSchema.safeParse({
      id: "event-3", type: "item/completed", threadId: "thr_1", scope: { kind: "turn", turnId: "turn-1" },
      seq: 14, createdAt: 11_000, data: { providerThreadId: "provider-thread", item: { type: "commandExecution", id: "i1" } },
    });
    expect(tool.success && [tool.data.turnId, tool.data.itemKind]).toEqual(["turn-1", "commandExecution"]);
    const legacy = itemEventRowSchema.safeParse({
      id: "event-4", type: "item/completed", threadId: "thr_1", scope: { kind: "turn", turnId: "turn-1" },
      seq: 15, createdAt: 11_000, itemKind: "fileChange", data: {},
    });
    expect(legacy.success && legacy.data.itemKind).toBe("fileChange");
    const threadScoped = itemEventRowSchema.safeParse({
      id: "event-5", type: "item/completed", threadId: "thr_1", scope: { kind: "thread" },
      seq: 16, createdAt: 11_000, itemKind: "toolCall", data: {},
    });
    expect(threadScoped.success).toBe(false);
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
  it("durationMs — окно последнего вызова модели; tokPerSec от него; длительность хода отдельно", () => {
    expect(windowOf({ windowStartedAt: 7_000, endedAt: 10_000, turnStartedAt: 1_000 })).toMatchObject({
      input: 1_200, cached: 265_000, cacheRead: 260_000, cacheWrite: 5_000,
      output: 42, reasoning: 7, total: 1_249, durationMs: 3_000, tokPerSec: 14, turnDurationMs: 9_000,
    });
  });

  it("ровно 1000 мс окна → tokPerSec есть", () => {
    expect(windowOf({ windowStartedAt: 9_000, endedAt: 10_000 })).toMatchObject({ durationMs: 1_000, tokPerSec: 42 });
  });

  it("не выдумывает скорость на коротком окне, нулевом output или некорректном старте", () => {
    const short = windowOf({ windowStartedAt: 9_001, endedAt: 10_000 });
    expect(Object.hasOwn(short, "tokPerSec")).toBe(false);
    for (const patch of [
      { windowStartedAt: 11_000, endedAt: 10_000 },
      { windowStartedAt: 10_000, endedAt: 10_000 },
    ]) {
      const row = windowOf(patch);
      expect(Object.hasOwn(row, "durationMs")).toBe(false);
      expect(Object.hasOwn(row, "tokPerSec")).toBe(false);
    }
    const zero = structuredClone(tokenUsage);
    zero.last.outputTokens = 0;
    const zeroRow = makeTurnUsage({
      threadId: "thr_1", turnId: "turn-1", tokenUsage: zero,
      windowStartedAt: 0, endedAt: 2_000, turnStartedAt: null, at: 2_000,
    });
    expect(Object.hasOwn(zeroRow, "tokPerSec")).toBe(false);
  });

  it("неизвестное окно (исчерпан lookback) → durationMs нет, а не окно=весь ход", () => {
    const row = windowOf({ endedAt: 10_000, turnStartedAt: 1_000 });
    expect(Object.hasOwn(row, "durationMs")).toBe(false);
    expect(Object.hasOwn(row, "tokPerSec")).toBe(false);
    expect(row.turnDurationMs).toBe(9_000);
  });

  it("старая запись с durationMs: null остаётся валидной", () => {
    const legacy = { ...turn("legacy", 1), durationMs: null };
    expect(turnUsageSchema.safeParse(legacy).success).toBe(true);
  });

  it("сохраняет resolved model/providerId и опускает их без значений", () => {
    const base = {
      threadId: "thr_1", turnId: "turn-1", tokenUsage,
      windowStartedAt: 9_000, endedAt: 10_000, turnStartedAt: null, at: 10_000,
    };
    expect(makeTurnUsage({ ...base, model: "test-model", providerId: "test-provider" })).toMatchObject({
      model: "test-model", providerId: "test-provider",
    });
    const bare = makeTurnUsage(base);
    expect(Object.hasOwn(bare, "model")).toBe(false);
    expect(Object.hasOwn(bare, "providerId")).toBe(false);
  });

  it("опускает необязательные поля вместо undefined на границе JSON", () => {
    const bare = structuredClone(tokenUsage);
    delete (bare.last as Record<string, unknown>).cacheReadInputTokens;
    delete (bare.last as Record<string, unknown>).cacheWriteInputTokens;
    const record = makeTurnUsage({
      threadId: "thr_1", turnId: "turn-1", tokenUsage: bare,
      windowStartedAt: 9_000, endedAt: 9_500, turnStartedAt: null, at: 9_500,
    });
    for (const field of ["cacheRead", "cacheWrite", "tokPerSec", "turnDurationMs", "model", "providerId"]) {
      expect(Object.hasOwn(record, field)).toBe(false);
    }
    expect(JSON.stringify(record)).not.toContain("undefined");
  });
});

describe("сводка и retention", () => {
  it("суммирует total по сохранённым ходам и усредняет только ходы со скоростью", () => {
    expect(summarizeTurns("thr_1", [turn("a", 1, 30), turn("b", 2), turn("c", 3, 50)], 1_000_000)).toEqual({
      threadId: "thr_1", total: 45, turns: 3, averageTokPerSec: 40, modelContextWindow: 1_000_000,
    });
  });

  it("сводка без скоростей не содержит averageTokPerSec", () => {
    const summary = summarizeTurns("thr_1", [turn("a", 1), turn("b", 2)], null);
    expect(Object.hasOwn(summary, "averageTokPerSec")).toBe(false);
    expect(summary).toMatchObject({ total: 30, turns: 2, modelContextWindow: null });
  });

  it("сводка берёт модель самого свежего хода, у которого она есть", () => {
    const summary = summarizeTurns("thr_1", [
      { ...turn("a", 1), model: "model-old" },
      turn("b", 2),
      { ...turn("c", 3), model: "model-new" },
    ], null);
    expect(summary.model).toBe("model-new");
    const withoutModel = summarizeTurns("thr_1", [turn("a", 1), { ...turn("b", 2), model: "model-b" }], null);
    expect(withoutModel.model).toBe("model-b");
  });

  it("ни у одного хода нет модели → поля model в сводке нет", () => {
    const summary = summarizeTurns("thr_1", [turn("a", 1), turn("b", 2)], null);
    expect("model" in summary).toBe(false);
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
