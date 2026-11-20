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
/** Фейк `bb.sdk.threads.defaultExecutionOptions`. */
type OptionsLookup = (args: { threadId: string }) => Promise<{ model: string } | null>;
/** Фейк `bb.sdk.threads.get`: там есть `providerId`, в options его нет. */
type ThreadLookup = (args: { threadId: string }) => Promise<{ providerId: string } | null>;
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

/** `client/turn/requested` висит на треде, а модель лежит в `data.execution.model`. */
function requestRow(model: string, seq: number, createdAt: number): EventRow {
  return {
    id: `event-${seq}`,
    scope: { kind: "thread" },
    type: "client/turn/requested",
    threadId: THREAD,
    seq,
    createdAt: eventAt(createdAt),
    data: { execution: { model } },
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
  defaultExecutionOptions?: OptionsLookup,
  settings: Record<string, string | boolean> = {},
  threadLookup?: ThreadLookup,
  onList?: (args: ListArgs) => void,
) {
  const calls: ListArgs[] = [];
  const host = createFakePluginHost({
    pluginId: "token-meter",
    settings,
    sdk: {
      threads: {
        defaultExecutionOptions: async (args: { threadId: string }) => defaultExecutionOptions?.(args) ?? null,
        get: async (args: { threadId: string }) => threadLookup?.(args) ?? { id: args.threadId },
        events: {
          list: async (args: ListArgs) => {
            calls.push(args);
            onList?.(args);
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
    const pageCalls = calls.filter((call) => call.types?.length === 4);
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
    const usagePages = calls.filter((call) => call.types?.length === 4);
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

it("модель хода — из client/turn/requested, providerId — из threads.get", async () => {
    const options = vi.fn<OptionsLookup>(async () => ({ model: "default-model" }));
    const thread = vi.fn<ThreadLookup>(async () => ({ providerId: "provider-from-thread" }));
    const { host } = await load([
      requestRow("model-from-event", 1, 500),
      row("turn/started", 2, 1_000),
      row("turn/completed", 3, 2_000),
      row("thread/tokenUsage/updated", 4, 2_000, { tokenUsage: tokenUsage() }),
    ], undefined, 0, options, {}, thread);
    await emit(host, 4);
    expect(thread).toHaveBeenCalledWith({ threadId: THREAD });
    // Событие есть → дефолт треда не нужен.
    expect(options).not.toHaveBeenCalled();
    expect(await host.bb.storage.kv.get(turnKey())).toMatchObject({
      model: "model-from-event", providerId: "provider-from-thread",
    });
  });

  it("смена модели между ходами → у каждого хода своя", async () => {
    const options = vi.fn<OptionsLookup>(async () => ({ model: "default-model" }));
    const { host } = await load([
      requestRow("model-a", 1, 500),
      row("turn/started", 2, 1_000, {}, "turn-1"),
      row("turn/completed", 3, 2_000, {}, "turn-1"),
      row("thread/tokenUsage/updated", 4, 2_000, { tokenUsage: tokenUsage() }, "turn-1"),
      requestRow("model-b", 5, 2_500),
      row("turn/started", 6, 3_000, {}, "turn-2"),
      row("turn/completed", 7, 4_000, {}, "turn-2"),
      row("thread/tokenUsage/updated", 8, 4_000, { tokenUsage: tokenUsage() }, "turn-2"),
    ], undefined, 0, options);
    await emit(host, 8);
    expect(options).not.toHaveBeenCalled();
    expect(await host.bb.storage.kv.get(turnKey("turn-1"))).toMatchObject({ model: "model-a" });
    expect(await host.bb.storage.kv.get(turnKey("turn-2"))).toMatchObject({ model: "model-b" });
  });

  it("catch-up бэклога не переписывает старый ход текущей моделью", async () => {
    const options = vi.fn<OptionsLookup>(async () => ({ model: "default-model" }));
    const rows: EventRow[] = [
      requestRow("model-a", 1, 500),
      row("turn/started", 2, 1_000, {}, "turn-1"),
      row("turn/completed", 3, 2_000, {}, "turn-1"),
      row("thread/tokenUsage/updated", 4, 2_000, { tokenUsage: tokenUsage() }, "turn-1"),
    ];
    const { host } = await load(rows, async (host) => {
      await host.bb.storage.kv.set(`token-meter:seq:${THREAD}`, 4);
    }, 0, options);
    await emit(host, 4);
    expect(await host.bb.storage.kv.get(turnKey("turn-1"))).toMatchObject({ model: "model-a" });
    rows.push(
      requestRow("model-b", 5, 2_500),
      row("turn/started", 6, 3_000, {}, "turn-2"),
      row("turn/completed", 7, 4_000, {}, "turn-2"),
      row("thread/tokenUsage/updated", 8, 4_000, { tokenUsage: tokenUsage() }, "turn-2"),
    );
    await emit(host, 8);
    expect(await host.bb.storage.kv.get(turnKey("turn-1"))).toMatchObject({ model: "model-a" });
    expect(await host.bb.storage.kv.get(turnKey("turn-2"))).toMatchObject({ model: "model-b" });
    expect(options).not.toHaveBeenCalled();
  });

  it("запрос модели после turn/started не относится к ходу", async () => {
    const { host } = await load([
      row("turn/started", 1, 1_000, {}, "turn-1"),
      requestRow("model-next", 2, 1_500),
      row("turn/completed", 3, 2_000, {}, "turn-1"),
      row("thread/tokenUsage/updated", 4, 2_000, { tokenUsage: tokenUsage() }, "turn-1"),
    ], undefined, 0, async () => ({ model: "default-model" }));
    await emit(host, 4);
    expect(await host.bb.storage.kv.get(turnKey("turn-1"))).toMatchObject({ model: "default-model" });
  });

  it("без turn/started запрос после usage не подменяет модель хода", async () => {
    const { host } = await load([
      requestRow("model-before-usage", 1, 500),
      row("turn/completed", 2, 2_000),
      row("thread/tokenUsage/updated", 3, 2_000, { tokenUsage: tokenUsage() }),
      requestRow("model-after-usage", 4, 2_500),
    ]);
    await emit(host, 4);
    expect(await host.bb.storage.kv.get(turnKey())).toMatchObject({ model: "model-before-usage" });
  });

  it("запрос с createdAt == turn/started относится к этому ходу", async () => {
    const { host } = await load([
      requestRow("model-at-turn-start", 1, 1_000),
      row("turn/started", 2, 1_000),
      row("turn/completed", 3, 2_000),
      row("thread/tokenUsage/updated", 4, 2_000, { tokenUsage: tokenUsage() }),
    ], undefined, 0, async () => ({ model: "default-model" }));
    await emit(host, 4);
    expect(await host.bb.storage.kv.get(turnKey())).toMatchObject({ model: "model-at-turn-start" });
  });

  it("без client/turn/requested → fallback на каждый ход, кэша модели нет", async () => {
    const options = vi.fn<OptionsLookup>(async () => ({ model: "default-model" }));
    const rows = [
      row("turn/started", 1, 1_000, {}, "turn-1"),
      row("turn/completed", 2, 2_000, {}, "turn-1"),
      row("thread/tokenUsage/updated", 3, 2_000, { tokenUsage: tokenUsage() }, "turn-1"),
    ];
    const { host } = await load(rows, undefined, 0, options);
    await emit(host, 3);
    rows.push(
      row("turn/started", 4, 3_000, {}, "turn-2"),
      row("turn/completed", 5, 4_000, {}, "turn-2"),
      row("thread/tokenUsage/updated", 6, 4_000, { tokenUsage: tokenUsage() }, "turn-2"),
    );
    await emit(host, 6);
    expect(options).toHaveBeenCalledTimes(2);
    expect(await host.bb.storage.kv.get(turnKey("turn-1"))).toMatchObject({ model: "default-model" });
    expect(await host.bb.storage.kv.get(turnKey("turn-2"))).toMatchObject({ model: "default-model" });
  });

  it("providerId кэшируется на тред, модель — нет", async () => {
    vi.useFakeTimers({ now: BASE });
    const thread = vi.fn<ThreadLookup>(async () => ({ providerId: "prov" }));
    const rows = [
      row("turn/started", 1, 1_000, {}, "turn-1"),
      row("turn/completed", 2, 2_000, {}, "turn-1"),
      row("thread/tokenUsage/updated", 3, 2_000, { tokenUsage: tokenUsage() }, "turn-1"),
    ];
    const { host } = await load(rows, undefined, 0, undefined, {}, thread);
    await emit(host, 3);
    rows.push(
      row("turn/started", 4, 3_000, {}, "turn-2"),
      row("turn/completed", 5, 4_000, {}, "turn-2"),
      row("thread/tokenUsage/updated", 6, 4_000, { tokenUsage: tokenUsage() }, "turn-2"),
    );
    await emit(host, 6);
    expect(thread).toHaveBeenCalledOnce();
    expect(host.harness.inspection.logEntries).toEqual([]);
    expect(await host.bb.storage.kv.get(turnKey("turn-2"))).toMatchObject({ providerId: "prov" });
  });

  it("providerId кэш истекает через 60 секунд", async () => {
    vi.useFakeTimers({ now: BASE });
    const thread = vi.fn<ThreadLookup>(async () => ({ providerId: "prov" }));
    const rows = [
      row("turn/started", 1, 1_000, {}, "turn-1"),
      row("turn/completed", 2, 2_000, {}, "turn-1"),
      row("thread/tokenUsage/updated", 3, 2_000, { tokenUsage: tokenUsage() }, "turn-1"),
    ];
    const { host } = await load(rows, undefined, 0, undefined, {}, thread);
    await emit(host, 3);
    vi.setSystemTime(BASE + 60_001);
    rows.push(
      row("turn/started", 4, 3_000, {}, "turn-2"),
      row("turn/completed", 5, 4_000, {}, "turn-2"),
      row("thread/tokenUsage/updated", 6, 4_000, { tokenUsage: tokenUsage() }, "turn-2"),
    );
    await emit(host, 6);
    expect(thread).toHaveBeenCalledTimes(2);
  });

  it("ошибка threads.get кэшируется на 60 секунд", async () => {
    vi.useFakeTimers({ now: BASE });
    const thread = vi.fn<ThreadLookup>(async () => { throw new Error("SDK unavailable"); });
    const rows = [
      row("turn/started", 1, 1_000, {}, "turn-1"),
      row("turn/completed", 2, 2_000, {}, "turn-1"),
      row("thread/tokenUsage/updated", 3, 2_000, { tokenUsage: tokenUsage() }, "turn-1"),
    ];
    const { host } = await load(rows, undefined, 0, undefined, {}, thread);
    await emit(host, 3);
    vi.setSystemTime(BASE + 59_999);
    rows.push(
      row("turn/started", 4, 3_000, {}, "turn-2"),
      row("turn/completed", 5, 4_000, {}, "turn-2"),
      row("thread/tokenUsage/updated", 6, 4_000, { tokenUsage: tokenUsage() }, "turn-2"),
    );
    await emit(host, 6);
    expect(thread).toHaveBeenCalledOnce();
    expect(await host.bb.storage.kv.get(turnKey("turn-2"))).toMatchObject({ input: 40, output: 60 });
  });

  it("ошибка list client/turn/requested → fallback, usage сохраняется", async () => {
    const options = vi.fn<OptionsLookup>(async () => ({ model: "default-model" }));
    const { host } = await load([
      requestRow("model-from-event", 1, 500),
      row("turn/started", 2, 1_000),
      row("turn/completed", 3, 2_000),
      row("thread/tokenUsage/updated", 4, 2_000, { tokenUsage: tokenUsage() }),
    ], undefined, 0, options, {}, undefined, (args) => {
      if (args.types?.length === 1 && args.types[0] === "client/turn/requested") {
        throw new Error("SDK unavailable");
      }
    });
    await emit(host, 4);
    expect(options).toHaveBeenCalledOnce();
    expect(await host.bb.storage.kv.get(turnKey())).toMatchObject({
      input: 40, output: 60, model: "default-model",
    });
    expect(host.harness.inspection.logEntries).toEqual([]);
  });

  it.each(["null", "error"])("defaultExecutionOptions=%s → вызывается, но model отсутствует", async (mode) => {
    const options = vi.fn<OptionsLookup>(async () => {
      if (mode === "error") throw new Error("SDK unavailable");
      return null;
    });
    const thread = vi.fn<ThreadLookup>(async () => ({ providerId: "prov" }));
    const { host } = await load([
      row("turn/started", 1, 1_000),
      row("turn/completed", 2, 2_000),
      row("thread/tokenUsage/updated", 3, 2_000, { tokenUsage: tokenUsage() }),
    ], undefined, 0, options, {}, thread);
    await emit(host, 3);
    expect(options).toHaveBeenCalledOnce();
    const record = await host.bb.storage.kv.get<Record<string, unknown>>(turnKey());
    expect(record).toMatchObject({ input: 40, output: 60, providerId: "prov" });
    expect(Object.hasOwn(record ?? {}, "model")).toBe(false);
    expect(JSON.stringify(record)).not.toContain("undefined");
  });

  it("ошибка threads.get → providerId отсутствует, usage сохраняется", async () => {
    const thread = vi.fn<ThreadLookup>(async () => { throw new Error("SDK unavailable"); });
    const { host } = await load([
      row("turn/started", 1, 1_000),
      row("turn/completed", 2, 2_000),
      row("thread/tokenUsage/updated", 3, 2_000, { tokenUsage: tokenUsage() }),
    ], undefined, 0, undefined, {}, thread);
    await emit(host, 3);
    const record = await host.bb.storage.kv.get<Record<string, unknown>>(turnKey());
    expect(record).toMatchObject({ input: 40, output: 60 });
    expect(Object.hasOwn(record ?? {}, "providerId")).toBe(false);
    expect(host.harness.inspection.logEntries).toEqual([]);
  });
});

describe("замер чистой генерации RPC", () => {
  const endpoint = "http://localhost:8317/v1";
  const enabled = { benchEnabled: true, benchEndpoint: endpoint, benchApiKey: "super-secret" };
  const response = (outputTokens: number): Response => ({
    ok: true,
    status: 200,
    json: async () => ({ usage: { completion_tokens: outputTokens } }),
  }) as Response;

  function stubBenchFetch() {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const steps = [
      { outputTokens: 100, durationMs: 1_000 },
      { outputTokens: 1_000, durationMs: 6_000 },
      { outputTokens: 100, durationMs: 1_000 },
      { outputTokens: 1_000, durationMs: 6_000 },
    ];
    const fetchMock = vi.fn(async () => {
      const step = steps[fetchMock.mock.calls.length - 1];
      if (!step) throw new Error("unexpected fetch");
      now += step.durationMs;
      return response(step.outputTokens);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it.each([
    ["выключен", { benchEnabled: false, benchEndpoint: endpoint }],
    ["без endpoint", { benchEnabled: true, benchEndpoint: "" }],
  ])("%s → отказ без сети", async (_name, settings) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { host } = await load([], undefined, 0, undefined, settings);
    await expect(host.harness.behavior.callRpc("bench_model", { model: "test-model" }))
      .rejects.toThrow(/выключен|benchEndpoint/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("сохраняет результат, возвращает list без секрета и инвалидирует bench", async () => {
    const fetchMock = stubBenchFetch();
    const lookup = vi.fn<OptionsLookup>(async () => ({ model: "test-model" }));
    const { host } = await load([
      row("turn/started", 1, 1_000),
      row("turn/completed", 2, 2_000),
      row("thread/tokenUsage/updated", 3, 2_000, { tokenUsage: tokenUsage() }),
    ], undefined, 0, lookup, enabled);
    await emit(host, 3);
    const result = await host.harness.behavior.callRpc("bench_model", { model: "test-model" });
    expect(result).toMatchObject({ model: "test-model", genTokPerSec: 180, latencyMs: 444 });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(await host.bb.storage.kv.get("token-meter:bench:test-model")).toEqual(result);
    const list = await host.harness.behavior.callRpc("bench_list", null);
    expect(list).toMatchObject({
      models: ["test-model"], results: [result], benchEnabled: true, hasEndpoint: true,
    });
    // Бейдж зовёт лёгкий метод: только замеры, без моделей и настроек.
    expect(await host.harness.behavior.callRpc("bench_results", null)).toEqual({ results: [result] });
    expect(host.harness.inspection.experimental_rpcInvalidations).toContainEqual(["bench"]);
    expect(JSON.stringify({
      result, list, logs: host.harness.inspection.logEntries,
    })).not.toContain("super-secret");
  });

  it("bench_list возвращает уникальные модели записанных ходов и только валидные замеры", async () => {
    const { host } = await load([], async (host) => {
      for (const [turnId, model] of [["a", "model-b"], ["b", "model-a"], ["c", "model-a"]] as const) {
        await host.bb.storage.kv.set(`token-meter:turn:${THREAD}:${turnId}`, {
          threadId: THREAD, turnId, input: 1, cached: 0, output: 1, reasoning: 0,
          total: 2, model, at: Date.now(),
        });
      }
      await host.bb.storage.kv.set("token-meter:bench:model-a", { broken: true });
    }, 0, undefined, { benchEnabled: false, benchEndpoint: "" });
    expect(await host.harness.behavior.callRpc("bench_list", null)).toEqual({
      models: ["model-a", "model-b"], results: [], benchEnabled: false, hasEndpoint: false,
    });
  });

  it("одновременно разрешён только один замер, lock снимается после завершения", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let releaseFirst = () => {};
    const steps = [
      { outputTokens: 1_000, durationMs: 6_000 },
      { outputTokens: 100, durationMs: 1_000 },
      { outputTokens: 1_000, durationMs: 6_000 },
    ];
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        releaseFirst = () => {
          now += 1_000;
          resolve(response(100));
        };
      }))
      .mockImplementation(async () => {
        const step = steps[fetchMock.mock.calls.length - 2];
        if (!step) throw new Error("unexpected fetch");
        now += step.durationMs;
        return response(step.outputTokens);
      });
    vi.stubGlobal("fetch", fetchMock);
    const { host } = await load([], undefined, 0, undefined, enabled);
    const first = host.harness.behavior.callRpc("bench_model", { model: "test-model" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await expect(host.harness.behavior.callRpc("bench_model", { model: "other-model" }))
      .rejects.toThrow("уже выполняется");
    releaseFirst();
    await expect(first).resolves.toMatchObject({ genTokPerSec: 180 });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    // После успешного resolve lock снят.
    stubBenchFetch();
    await expect(host.harness.behavior.callRpc("bench_model", { model: "other-model" }))
      .resolves.toMatchObject({ genTokPerSec: 180 });
  });

  it("bench_results отдаёт только замеры, без моделей и секрета", async () => {
    const { host } = await load([], async (host) => {
      await host.bb.storage.kv.set("token-meter:bench:model-a", {
        model: "model-a", genTokPerSec: 207.2, latencyMs: 1_040, at: Date.now(),
        samples: [
          { maxTokens: 150, outputTokens: 100, durationMs: 1_000 },
          { maxTokens: 1_500, outputTokens: 1_000, durationMs: 6_000 },
          { maxTokens: 150, outputTokens: 100, durationMs: 1_000 },
          { maxTokens: 1_500, outputTokens: 1_000, durationMs: 6_000 },
        ],
      });
      await host.bb.storage.kv.set("token-meter:bench:broken", { broken: true });
    }, 0, undefined, enabled);
    const light = await host.harness.behavior.callRpc("bench_results", null);
    expect(light).toMatchObject({ results: [{ model: "model-a", genTokPerSec: 207.2 }] });
    expect(Object.keys(light as Record<string, unknown>)).toEqual(["results"]);
    expect(JSON.stringify(light)).not.toContain("super-secret");
  });

  it("lock снимается после ошибки замера", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("bad Bearer super-secret");
    }));
    const { host } = await load([], undefined, 0, undefined, enabled);
    await expect(host.harness.behavior.callRpc("bench_model", { model: "test-model" }))
      .rejects.toThrow(/\[secret\]/);
    const fetchMock = stubBenchFetch();
    await expect(host.harness.behavior.callRpc("bench_model", { model: "test-model" }))
      .resolves.toMatchObject({ genTokPerSec: 180 });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("отмена вызывающего освобождает lock, замер не записывается", async () => {
    const fetchMock = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      if (init?.signal?.aborted) reject(new DOMException("aborted", "AbortError"));
    }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const { host } = await load([], undefined, 0, undefined, enabled);
    const first = host.harness.behavior.callRpc("bench_model", { model: "test-model" }, { signal: controller.signal });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort();
    await expect(first).rejects.toThrow("замер отменён");
    expect(await host.bb.storage.kv.get("token-meter:bench:test-model")).toBeUndefined();
    const ok = stubBenchFetch();
    await expect(host.harness.behavior.callRpc("bench_model", { model: "test-model" }))
      .resolves.toMatchObject({ genTokPerSec: 180 });
    expect(ok).toHaveBeenCalledTimes(4);
  });
});
