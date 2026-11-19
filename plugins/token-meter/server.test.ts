import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { RETENTION_MS } from "./lib/usage.js";
import plugin from "./server.js";

const THREAD = "thr_1";
const TURN = "turn-1";
const BASE = Date.now();
const eventAt = (offset: number) => BASE + offset;
type Host = ReturnType<typeof createFakePluginHost>;
type EventRow = Record<string, unknown>;
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

async function load(rows: EventRow[], beforeLoad?: (host: Host) => Promise<void>) {
  const calls: ListArgs[] = [];
  const host = createFakePluginHost({
    pluginId: "token-meter",
    sdk: {
      threads: {
        events: {
          list: async (args: ListArgs) => {
            calls.push(args);
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
  await Promise.all(hosts.splice(0).map((host) => host.harness.lifecycle.dispose()));
});

describe("события → kv → RPC", () => {
  it("сохраняет duration/rate, сводку, seq, realtime; missing keyed row = null; undefined нет", async () => {
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
      durationMs: 3_000, tokPerSec: 20, at: eventAt(4_000),
    });
    expect(await host.bb.storage.kv.get(`token-meter:seq:${THREAD}`)).toBe(3);
    expect(host.harness.inspection.realtimeSignals).toContainEqual({ channel: "token-meter-changed", payload: { threadId: THREAD } });

    const keyed = await host.harness.behavior.callRpc("turn_usage", { keys: [`${THREAD}:${TURN}`, `${THREAD}:missing`] });
    expect(keyed).toMatchObject({ [`${THREAD}:missing`]: null });
    const summary = await host.harness.behavior.callRpc("thread_usage", { threadId: THREAD });
    expect(summary).toEqual({ threadId: THREAD, total: 6_000, turns: 1, averageTokPerSec: 20, modelContextWindow: 128_000 });
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
    expect(host.harness.inspection.realtimeSignals).toHaveLength(1);
    const callCount = calls.length;
    await emit(host, 4);
    expect(calls).toHaveLength(callCount);
    expect(host.harness.inspection.realtimeSignals).toHaveLength(1);
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

  it("провайдер без usage и битое usage → нет записей/realtime, но seq продвигается", async () => {
    const malformed = row("thread/tokenUsage/updated", 3, 3_000, { tokenUsage: { last: { inputTokens: 1 } } });
    const { host } = await load([row("turn/started", 1, 1_000), row("turn/completed", 2, 2_000), malformed]);
    await emit(host, 3);
    expect(await host.bb.storage.kv.list("token-meter:turn:")).toEqual([]);
    expect(host.harness.inspection.realtimeSignals).toEqual([]);
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
});
