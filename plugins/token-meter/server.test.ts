import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RETENTION_MS } from "./lib/usage.js";
import plugin from "./server.js";

const THREAD = "thr_1";
const TURN = "turn-1";
const BASE = Date.now();
const eventAt = (offset: number) => BASE + offset;
type Host = ReturnType<typeof createFakePluginHost>;
type EventRow = Record<string, unknown>;
type ExecutionLookup = (args: { threadId: string }) => Promise<{ model: string; providerId?: string } | null>;
type ListArgs = {
  threadId: string;
  afterSeq?: string;
  beforeSeq?: string;
  limit?: string;
  order?: "asc" | "desc";
  types?: readonly string[];
};
const hosts: Host[] = [];

function tokenUsage(output = 60) {
  const values = (total: number) => ({
    inputTokens: total - output,
    cachedInputTokens: 20,
    cacheReadInputTokens: 15,
    cacheWriteInputTokens: 5,
    outputTokens: output,
    reasoningOutputTokens: 4,
    totalTokens: total,
  });
  return { last: values(100), total: values(6_000), modelContextWindow: 128_000 };
}

function row(type: string, seq: number, createdAt: number, data: Record<string, unknown> = {}, turnId = TURN): EventRow {
  return {
    id: `event-${seq}`,
    scope: { kind: "turn", turnId },
    type,
    threadId: THREAD,
    seq,
    createdAt: eventAt(createdAt),
    data: { providerThreadId: "provider-thread", ...data },
  };
}

function listEvents(rows: EventRow[], args: ListArgs): EventRow[] {
  const after = Number(args.afterSeq ?? 0);
  const before = Number(args.beforeSeq ?? Number.POSITIVE_INFINITY);
  const limit = Number(args.limit ?? 100);
  // Настоящий bb отвечает 400 на limit > 100; фейк ведёт себя так же.
  if (limit > 100) throw new Error("HTTP 400: Thread event limit cannot exceed 100");
  return rows
    .filter((event) => event.threadId === THREAD)
    .filter((event) => !args.types || args.types.includes(String(event.type)))
    .filter((event) => Number(event.seq) > after && Number(event.seq) < before)
    .sort((a, b) => (Number(a.seq) - Number(b.seq)) * (args.order === "desc" ? -1 : 1))
    .slice(0, limit);
}

async function load(
  rows: EventRow[],
  beforeLoad?: (host: Host) => Promise<void>,
  delayMs = 0,
  defaultExecutionOptions?: ExecutionLookup,
) {
  const calls: ListArgs[] = [];
  const host = createFakePluginHost({
    pluginId: "token-meter",
    sdk: {
      threads: {
        defaultExecutionOptions: async (args: { threadId: string }) => defaultExecutionOptions?.(args) ?? null,
        events: {
          list: async (args: ListArgs) => {
            calls.push(args);
            if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
            return listEvents(rows, args);
          },
        },
      },
    },
  });
  await beforeLoad?.(host);
  await plugin(host.bb);
  hosts.push(host);
  return { host, calls };
}

async function emit(host: Host, sequence: number) {
  await host.harness.behavior.emitThreadEvent("experimental_thread.events", {
    thread: makeThreadResponse({ id: THREAD }),
    sequence,
  });
}

function turnKey(turnId = TURN): string {
  return `token-meter:turn:${THREAD}:${turnId}`;
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(hosts.splice(0).map((host) => host.harness.lifecycle.dispose()));
});

describe("события → kv → RPC", () => {
  it("сохраняет окно вызова, сводку, seq, инвалидацию; missing keyed row = null; undefined нет", async () => {
    const { host } = await load([
      row("turn/started", 1, 1_000),
      row("turn/completed", 2, 4_000),
      row("thread/tokenUsage/updated", 3, 4_000, { tokenUsage: tokenUsage() }),
    ]);
    await emit(host, 3);

    expect(host.harness.inspection.logEntries).toEqual([]);
    expect(await host.bb.storage.kv.get(turnKey())).toMatchObject({
      threadId: THREAD, turnId: TURN, input: 40, cached: 20, cacheRead: 15,
      cacheWrite: 5, output: 60, reasoning: 4, total: 100,
      durationMs: 3_000, turnDurationMs: 3_000, tokPerSec: 20, at: eventAt(4_000),
    });
    expect(await host.bb.storage.kv.get(`token-meter:seq:${THREAD}`)).toBe(3);
    expect(host.harness.inspection.experimental_rpcInvalidations).toEqual([["thread:thr_1"]]);

    const keyed = await host.harness.behavior.callRpc("turn_usage", { keys: [`${THREAD}:${TURN}`, `${THREAD}:missing`] });
    expect(keyed).toMatchObject({ [`${THREAD}:missing`]: null });
    const summary = await host.harness.behavior.callRpc("thread_usage", { threadId: THREAD });
    expect(summary).toEqual({ threadId: THREAD, total: 100, turns: 1, averageTokPerSec: 20, modelContextWindow: 128_000 });
    expect(JSON.stringify({ keyed, summary })).not.toContain("undefined");
  });

  it("несколько usage в ходе → последнее; повторный сигнал дедуплицируется", async () => {
    const { host, calls } = await load([
      row("turn/started", 1, 1_000),
      row("thread/tokenUsage/updated", 2, 2_000, { tokenUsage: tokenUsage(10) }),
      row("turn/completed", 3, 3_000),
      row("thread/tokenUsage/updated", 4, 3_000, { tokenUsage: tokenUsage(40) }),
    ]);
    await emit(host, 4);
    expect(await host.bb.storage.kv.get(turnKey())).toMatchObject({ output: 40, durationMs: 2_000, tokPerSec: 20, at: eventAt(3_000) });
    expect(host.harness.inspection.experimental_rpcInvalidations).toHaveLength(1);
    const callCount = calls.length;
    await emit(host, 4);
    expect(calls).toHaveLength(callCount);
    expect(host.harness.inspection.experimental_rpcInvalidations).toHaveLength(1);
  });

  it("turn/started до lastSeenSeq находит дополнительным list", async () => {
    const rows = [
      row("turn/started", 1, 1_000),
      row("turn/completed", 2, 5_000),
      row("thread/tokenUsage/updated", 3, 5_000, { tokenUsage: tokenUsage() }),
    ];
    const { host, calls } = await load(rows);
    await host.bb.storage.kv.set(`token-meter:seq:${THREAD}`, 2);
    await emit(host, 3);
    expect(await host.bb.storage.kv.get(turnKey())).toMatchObject({ durationMs: 4_000, tokPerSec: 15 });
    const startedCall = calls.find((call) => call.types?.length === 1 && call.types[0] === "turn/started");
    expect(startedCall).toMatchObject({ order: "desc", beforeSeq: "3", limit: "20" });
    const toolCall = calls.find((call) => call.types?.includes("item/completed"));
    expect(toolCall).toMatchObject({ order: "desc", beforeSeq: "3", limit: "10" });
  });

  it("usage без turn-скоупа игнорируется, seq всё равно продвигается", async () => {
    const threadScoped = { ...row("thread/tokenUsage/updated", 3, 3_000, { tokenUsage: tokenUsage() }), scope: { kind: "thread" } };
    const { host } = await load([row("turn/started", 1, 1_000), row("turn/completed", 2, 2_000), threadScoped]);
    await emit(host, 3);
    expect(await host.bb.storage.kv.list("token-meter:turn:")).toEqual([]);
  });

  it("пагинация по 100: 250 событий → 3 страницы, все ходы записаны", async () => {
    const rows: EventRow[] = [];
    let seq = 0;
    for (let turn = 1; turn <= 83; turn += 1) {
      const turnId = `turn-${turn}`;
      rows.push(row("turn/started", ++seq, 1_000, {}, turnId));
      rows.push(row("turn/completed", ++seq, 3_000, {}, turnId));
      rows.push(row("thread/tokenUsage/updated", ++seq, 3_000, { tokenUsage: tokenUsage() }, turnId));
    }
    expect(rows).toHaveLength(249);
    const { host, calls } = await load(rows);
    await emit(host, 249);
    const pageCalls = calls.filter((call) => call.types?.length === 3);
    expect(pageCalls.map((call) => [call.afterSeq, call.limit])).toEqual([
      ["0", "100"],
      ["100", "100"],
      ["200", "100"],
    ]);
    const keys = await host.bb.storage.kv.list("token-meter:turn:");
    expect(keys).toHaveLength(83);
    expect(await host.harness.behavior.callRpc("thread_usage", { threadId: THREAD })).toMatchObject({ turns: 83 });
  });

  it("провайдер без usage и битое usage → нет записей/инвалидации, но seq продвигается", async () => {
    const malformed = row("thread/tokenUsage/updated", 3, 3_000, { tokenUsage: { last: { inputTokens: 1 } } });
    const { host } = await load([row("turn/started", 1, 1_000), row("turn/completed", 2, 2_000), malformed]);
    await emit(host, 3);
    expect(await host.bb.storage.kv.list("token-meter:turn:")).toEqual([]);
    expect(host.harness.inspection.experimental_rpcInvalidations).toEqual([]);
    expect(await host.bb.storage.kv.get(`token-meter:seq:${THREAD}`)).toBe(3);
    expect(await host.harness.behavior.callRpc("thread_usage", { threadId: THREAD })).toBeNull();
  });

  it("lastSeenSeq продвигается до sequence сигнала даже без target-событий", async () => {
    const { host, calls } = await load([row("turn/started", 1, 1_000)]);
    await emit(host, 5);
    expect(await host.bb.storage.kv.get(`token-meter:seq:${THREAD}`)).toBe(5);
    const callCount = calls.length;
    await emit(host, 6);
    expect(calls.length).toBe(callCount + 1);
    expect(calls.at(-1)?.afterSeq).toBe("5");
    expect(await host.bb.storage.kv.get(`token-meter:seq:${THREAD}`)).toBe(6);
  });

  it("окно последнего вызова модели — от конца последнего инструмента, ход отдельно", async () => {
    const { host } = await load([
      row("turn/started", 1, 0),
      row("item/completed", 2, 2_000, { item: { type: "commandExecution", id: "i1" } }),
      row("item/completed", 3, 9_000, { item: { type: "fileChange", id: "i2" } }),
      row("item/completed", 4, 9_500, { item: { type: "reasoning", id: "i3" } }),
      row("item/completed", 5, 9_600, { item: { type: "agentMessage", id: "i4" } }),
      row("turn/completed", 6, 10_000),
      row("thread/tokenUsage/updated", 7, 10_000, { tokenUsage: tokenUsage() }),
    ]);
    await emit(host, 7);
    expect(await host.bb.storage.kv.get(turnKey())).toMatchObject({
      durationMs: 1_000, turnDurationMs: 10_000, tokPerSec: 60,
    });
  });

  it("инструмент другого хода не расширяет окно", async () => {
    const { host } = await load([
      row("item/completed", 1, 1_000, { item: { type: "commandExecution", id: "prev" } }, "turn-0"),
      row("turn/started", 2, 9_000),
      row("turn/completed", 3, 12_000),
      row("thread/tokenUsage/updated", 4, 12_000, { tokenUsage: tokenUsage() }),
    ]);
    await emit(host, 4);
    expect(await host.bb.storage.kv.get(turnKey())).toMatchObject({ durationMs: 3_000, turnDurationMs: 3_000 });
  });

  it("turn/completed позже usage.createdAt закрывает окно позже", async () => {
    const { host } = await load([
      row("turn/started", 1, 0),
      row("item/completed", 2, 2_000, { item: { type: "toolCall", id: "i1" } }),
      row("thread/tokenUsage/updated", 3, 5_000, { tokenUsage: tokenUsage() }),
      row("turn/completed", 4, 7_000),
    ]);
    await emit(host, 4);
    expect(await host.bb.storage.kv.get(turnKey())).toMatchObject({ durationMs: 5_000, turnDurationMs: 7_000, at: eventAt(5_000) });
  });

  it("два turn/started в lookback — берётся свой turnId", async () => {
    const { host } = await load([
      row("turn/started", 1, 1_000, {}, "turn-a"),
      row("turn/started", 2, 4_000, {}, "turn-b"),
      row("turn/completed", 3, 6_000, {}, "turn-a"),
      row("thread/tokenUsage/updated", 4, 6_000, { tokenUsage: tokenUsage() }, "turn-a"),
    ]);
    await host.bb.storage.kv.set(`token-meter:seq:${THREAD}`, 3);
    await emit(host, 4);
    expect(await host.bb.storage.kv.get(turnKey("turn-a"))).toMatchObject({ durationMs: 5_000, turnDurationMs: 5_000 });
  });

  it("501-й ход вытесняет самый старый, сводка остаётся на 500", async () => {
    const now = Date.now();
    const { host } = await load([
      row("turn/started", 1, 1_000),
      row("turn/completed", 2, 2_000),
      row("thread/tokenUsage/updated", 3, 2_000, { tokenUsage: tokenUsage() }),
    ], async (host) => {
      for (let i = 0; i < 500; i += 1) {
        await host.bb.storage.kv.set(`token-meter:turn:${THREAD}:old-${i}`, {
          threadId: THREAD, turnId: `old-${i}`, input: 1, cached: 0, output: 1,
          reasoning: 0, total: 2, durationMs: 1_000, tokPerSec: 1, at: now - 1_000 - i,
        });
      }
    });
    await emit(host, 3);
    const keys = await host.bb.storage.kv.list(`token-meter:turn:${THREAD}:`);
    expect(keys).toHaveLength(500);
    expect(keys).not.toContain(`token-meter:turn:${THREAD}:old-499`);
    expect(await host.harness.behavior.callRpc("thread_usage", { threadId: THREAD }))
      .toMatchObject({ turns: 500, total: 500 * 2 + 100 - 2 });
  });

  it("два параллельных сигнала треда → один набор записей и одна позиция", async () => {
    const { host, calls } = await load([
      row("turn/started", 1, 1_000),
      row("turn/completed", 2, 2_000),
      row("thread/tokenUsage/updated", 3, 2_000, { tokenUsage: tokenUsage() }),
    ], undefined, 5);
    await Promise.all([emit(host, 3), emit(host, 3)]);
    expect(await host.bb.storage.kv.list(`token-meter:turn:${THREAD}:`)).toEqual([turnKey()]);
    expect(await host.bb.storage.kv.get(`token-meter:seq:${THREAD}`)).toBe(3);
    const usagePages = calls.filter((call) => call.types?.length === 3);
    expect(usagePages).toHaveLength(1);
    expect(host.harness.inspection.experimental_rpcInvalidations).toHaveLength(1);
  });

  it("исчерпанный lookback без инструмента → нет durationMs и ток/с", async () => {
    const rows: EventRow[] = [row("turn/started", 1, 0)];
    let seq = 1;
    rows.push(row("item/completed", ++seq, 1_000, { item: { type: "commandExecution", id: "tool" } }));
    for (let pair = 0; pair < 6; pair += 1) {
      rows.push(row("item/started", ++seq, 2_000 + pair * 100, { item: { type: "reasoning", id: `r${pair}` } }));
      rows.push(row("item/completed", ++seq, 2_050 + pair * 100, { item: { type: "reasoning", id: `r${pair}` } }));
    }
    rows.push(row("turn/completed", ++seq, 9_000));
    rows.push(row("thread/tokenUsage/updated", ++seq, 9_000, { tokenUsage: tokenUsage() }));
    const { host } = await load(rows);
    await emit(host, seq);
    const record = await host.bb.storage.kv.get<Record<string, unknown>>(turnKey());
    expect(Object.hasOwn(record ?? {}, "durationMs")).toBe(false);
    expect(Object.hasOwn(record ?? {}, "tokPerSec")).toBe(false);
    expect(record?.turnDurationMs).toBe(9_000);
  });

  it("thread.deleted удаляет все ключи треда", async () => {
    const { host } = await load([
      row("turn/started", 1, 1_000),
      row("turn/completed", 2, 2_000),
      row("thread/tokenUsage/updated", 3, 2_000, { tokenUsage: tokenUsage() }),
    ]);
    await emit(host, 3);
    await host.harness.behavior.emitThreadEvent("thread.deleted", { thread: makeThreadResponse({ id: THREAD }) });
    expect(host.harness.inspection.experimental_rpcInvalidations).toContainEqual(["thread:thr_1"]);
    expect(await host.bb.storage.kv.list("token-meter:")).toEqual([]);
    expect(await host.harness.behavior.callRpc("thread_usage", { threadId: THREAD })).toBeNull();
  });

  it("startup prune чистит сводки и позиции без ходов", async () => {
    const { host } = await load([], async (host) => {
      await host.bb.storage.kv.set(`token-meter:thread:${THREAD}`, { threadId: THREAD, total: 5, turns: 1, modelContextWindow: null });
      await host.bb.storage.kv.set(`token-meter:seq:${THREAD}`, 42);
    });
    expect(await host.bb.storage.kv.list("token-meter:")).toEqual([]);
    expect(host.harness.inspection.logEntries).toEqual([]);
  });

  it("usage без cache read/write → запись не содержит этих полей", async () => {
    const bare = tokenUsage();
    delete (bare.last as Record<string, unknown>).cacheReadInputTokens;
    delete (bare.last as Record<string, unknown>).cacheWriteInputTokens;
    const { host } = await load([
      row("turn/started", 1, 1_000),
      row("turn/completed", 2, 2_000),
      row("thread/tokenUsage/updated", 3, 2_000, { tokenUsage: bare }),
    ]);
    await emit(host, 3);
    const record = await host.bb.storage.kv.get<Record<string, unknown>>(turnKey());
    expect(record === undefined ? [] : Object.keys(record)).not.toContain("cacheRead");
    expect(Object.hasOwn(record ?? {}, "cacheWrite")).toBe(false);
  });

  it("usage старше 30 дней на первом проходе → ход вытеснен, сводки нет", async () => {
    const offset = -RETENTION_MS - 1_000;
    const { host } = await load([
      row("turn/started", 1, offset),
      row("turn/completed", 2, offset + 1_000),
      row("thread/tokenUsage/updated", 3, offset + 1_000, { tokenUsage: tokenUsage() }),
    ]);
    await emit(host, 3);
    expect(await host.bb.storage.kv.list(`token-meter:turn:${THREAD}:`)).toEqual([]);
    expect(await host.bb.storage.kv.get(`token-meter:thread:${THREAD}`)).toBeUndefined();
    expect(await host.harness.behavior.callRpc("thread_usage", { threadId: THREAD })).toBeNull();
    expect(host.harness.inspection.experimental_rpcInvalidations).toHaveLength(1);
  });

  it("сводка хранится только по свежим ходам, без скоростей — без averageTokPerSec", async () => {
    const { host } = await load([
      row("turn/started", 1, 1_000),
      row("turn/completed", 2, 1_500),
      row("thread/tokenUsage/updated", 3, 1_500, { tokenUsage: tokenUsage() }),
    ]);
    await emit(host, 3);
    const summary = await host.harness.behavior.callRpc("thread_usage", { threadId: THREAD });
    expect(Object.hasOwn(summary as Record<string, unknown>, "averageTokPerSec")).toBe(false);
  });

  it("startup prune удаляет usage старше 30 дней и устаревшую сводку", async () => {
    const oldTurn = {
      threadId: THREAD, turnId: TURN, input: 1, cached: 0, output: 1,
      reasoning: 0, total: 2, durationMs: 1_000, tokPerSec: 1,
      at: Date.now() - RETENTION_MS - 1,
    };
    const { host } = await load([], async (host) => {
      await host.bb.storage.kv.set(turnKey(), oldTurn);
      await host.bb.storage.kv.set(`token-meter:thread:${THREAD}`, {
        threadId: THREAD, total: 2, turns: 1, averageTokPerSec: 1, modelContextWindow: null,
      });
    });
    expect(await host.bb.storage.kv.get(turnKey())).toBeUndefined();
    expect(await host.harness.behavior.callRpc("thread_usage", { threadId: THREAD })).toBeNull();
  });

  it("сохраняет model/providerId из defaultExecutionOptions", async () => {
    const lookup = vi.fn<ExecutionLookup>(async () => ({ model: "test-model", providerId: "test-provider" }));
    const { host } = await load([
      row("turn/started", 1, 1_000),
      row("turn/completed", 2, 2_000),
      row("thread/tokenUsage/updated", 3, 2_000, { tokenUsage: tokenUsage() }),
    ], undefined, 0, lookup);
    await emit(host, 3);
    expect(lookup).toHaveBeenCalledWith({ threadId: THREAD });
    expect(await host.bb.storage.kv.get(turnKey())).toMatchObject({
      model: "test-model", providerId: "test-provider",
    });
  });

  it.each(["null", "error"])("defaultExecutionOptions=%s → вызывается, но model/providerId отсутствуют", async (mode) => {
    const lookup = vi.fn<ExecutionLookup>(async () => {
      if (mode === "error") throw new Error("SDK unavailable");
      return null;
    });
    const { host } = await load([
      row("turn/started", 1, 1_000),
      row("turn/completed", 2, 2_000),
      row("thread/tokenUsage/updated", 3, 2_000, { tokenUsage: tokenUsage() }),
    ], undefined, 0, lookup);
    await emit(host, 3);
    expect(lookup).toHaveBeenCalledOnce();
    const record = await host.bb.storage.kv.get<Record<string, unknown>>(turnKey());
    expect(record).toMatchObject({ input: 40, output: 60 });
    expect(Object.hasOwn(record ?? {}, "model")).toBe(false);
    expect(Object.hasOwn(record ?? {}, "providerId")).toBe(false);
    expect(JSON.stringify(record)).not.toContain("undefined");
  });

  it("кэширует execution options на тред 60 секунд", async () => {
    vi.useFakeTimers({ now: BASE });
    const lookup = vi.fn<ExecutionLookup>(async () => ({ model: "test-model", providerId: "test-provider" }));
    const rows = [
      row("turn/started", 1, 1_000, {}, "turn-1"),
      row("turn/completed", 2, 2_000, {}, "turn-1"),
      row("thread/tokenUsage/updated", 3, 2_000, { tokenUsage: tokenUsage() }, "turn-1"),
    ];
    const { host } = await load(rows, undefined, 0, lookup);
    await emit(host, 3);
    rows.push(
      row("turn/started", 4, 3_000, {}, "turn-2"),
      row("turn/completed", 5, 4_000, {}, "turn-2"),
      row("thread/tokenUsage/updated", 6, 4_000, { tokenUsage: tokenUsage() }, "turn-2"),
    );
    await emit(host, 6);
    expect(lookup).toHaveBeenCalledOnce();
    vi.setSystemTime(BASE + 60_001);
    rows.push(
      row("turn/started", 7, 5_000, {}, "turn-3"),
      row("turn/completed", 8, 6_000, {}, "turn-3"),
      row("thread/tokenUsage/updated", 9, 6_000, { tokenUsage: tokenUsage() }, "turn-3"),
    );
    await emit(host, 9);
    expect(await host.bb.storage.kv.get(`token-meter:seq:${THREAD}`)).toBe(9);
    expect(host.harness.inspection.logEntries).toEqual([]);
    expect(await host.bb.storage.kv.get(turnKey("turn-3"))).toMatchObject({ model: "test-model" });
    expect(lookup).toHaveBeenCalledTimes(2);
  });
});
