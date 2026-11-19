import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  rpcContract,
  threadUsageSchema,
  turnEventRowSchema,
  turnUsageSchema,
  usageEventRowSchema,
  type TurnUsage,
  type UsageEventRow,
} from "./lib/contract.js";
import { makeTurnUsage, retainTurns, summarizeTurns } from "./lib/usage.js";

const EVENT_TYPES = ["thread/tokenUsage/updated", "turn/started", "turn/completed"] as const;
/** Лимит API bb: threads.events.list отвечает HTTP 400 на limit > 100. */
const EVENTS_PAGE_LIMIT = 100;
const STARTED_LOOKBACK = 20;
const TURN_PREFIX = "token-meter:turn:";

function pageLimit(size: number): string {
  return String(Math.min(size, EVENTS_PAGE_LIMIT));
}

type Kv = BbPluginApi["storage"]["kv"];

function turnKey(threadId: string, turnId: string): string {
  return `${TURN_PREFIX}${threadId}:${turnId}`;
}

function sequenceKey(threadId: string): string {
  return `token-meter:seq:${threadId}`;
}

function summaryKey(threadId: string): string {
  return `token-meter:thread:${threadId}`;
}

async function readTurns(kv: Kv, threadId: string): Promise<TurnUsage[]> {
  const keys = await kv.list(`${TURN_PREFIX}${threadId}:`);
  const rows = await Promise.all(keys.map((key) => kv.get<unknown>(key)));
  return rows.flatMap((row) => {
    const parsed = turnUsageSchema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
}

async function pruneThread(kv: Kv, threadId: string, now: number): Promise<TurnUsage[]> {
  // ponytail: O(n) чтение всех ходов треда на каждую запись; при лимите 500 локальных kv.get это дёшево.
  const rows = await readTurns(kv, threadId);
  const retained = retainTurns(rows, now);
  await Promise.all(retained.removed.map((row) => kv.delete(turnKey(row.threadId, row.turnId))));
  return retained.kept;
}

async function saveUsage(
  bb: BbPluginApi,
  event: UsageEventRow,
  startedAt: number | null,
  completedAt: number,
): Promise<void> {
  const { threadId, turnId } = event;
  const record = makeTurnUsage({
    threadId,
    turnId,
    tokenUsage: event.data.tokenUsage,
    startedAt,
    completedAt,
    at: event.createdAt,
  });
  await bb.storage.kv.set(turnKey(threadId, turnId), record);
  const kept = await pruneThread(bb.storage.kv, threadId, Date.now());
  const summary = summarizeTurns(
    threadId,
    kept,
    event.data.tokenUsage.total.totalTokens,
    event.data.tokenUsage.modelContextWindow,
  );
  await bb.storage.kv.set(summaryKey(threadId), summary);
}

async function pruneAll(bb: BbPluginApi): Promise<void> {
  const keys = await bb.storage.kv.list(TURN_PREFIX);
  const byThread = new Map<string, TurnUsage[]>();
  for (const key of keys) {
    const parsed = turnUsageSchema.safeParse(await bb.storage.kv.get<unknown>(key));
    if (!parsed.success) continue;
    const rows = byThread.get(parsed.data.threadId) ?? [];
    rows.push(parsed.data);
    byThread.set(parsed.data.threadId, rows);
  }
  for (const [threadId, rows] of byThread) {
    const retained = retainTurns(rows, Date.now());
    if (retained.removed.length === 0) continue;
    await Promise.all(retained.removed.map((row) => bb.storage.kv.delete(turnKey(threadId, row.turnId))));
    if (retained.kept.length === 0) {
      await bb.storage.kv.delete(summaryKey(threadId));
      continue;
    }
    const previous = threadUsageSchema.safeParse(await bb.storage.kv.get<unknown>(summaryKey(threadId)));
    if (!previous.success) {
      await bb.storage.kv.delete(summaryKey(threadId));
      continue;
    }
    await bb.storage.kv.set(summaryKey(threadId), summarizeTurns(
      threadId,
      retained.kept,
      previous.data.total,
      previous.data.modelContextWindow,
    ));
  }
}

async function findStartedAt(
  bb: BbPluginApi,
  threadId: string,
  usageSeq: number,
  turnId: string,
): Promise<number | null> {
  // ponytail: последние 20 turn/started перед usage-событием; старее — durationMs:null вместо выдумки.
  const rows = await bb.sdk.threads.events.list({
    threadId,
    types: ["turn/started"],
    beforeSeq: String(usageSeq),
    order: "desc",
    limit: pageLimit(STARTED_LOOKBACK),
  });
  for (const row of rows) {
    const parsed = turnEventRowSchema.safeParse(row);
    if (parsed.success && parsed.data.turnId === turnId) return parsed.data.createdAt;
  }
  return null;
}

async function syncThread(bb: BbPluginApi, threadId: string, signalSequence: number): Promise<void> {
  let afterSeq = await bb.storage.kv.get<number>(sequenceKey(threadId)) ?? 0;
  if (afterSeq >= signalSequence) return;
  let changed = false;

  while (afterSeq < signalSequence) {
    const rows = await bb.sdk.threads.events.list({
      threadId,
      afterSeq: String(afterSeq),
      limit: pageLimit(EVENTS_PAGE_LIMIT),
      order: "asc",
      types: EVENT_TYPES,
    });
    if (rows.length === 0) {
      await bb.storage.kv.set(sequenceKey(threadId), signalSequence);
      break;
    }

    let maxSeq = afterSeq;
    const usageByTurn = new Map<string, UsageEventRow>();
    const started = new Map<string, number>();
    const completed = new Map<string, number>();
    for (const row of rows) {
      maxSeq = Math.max(maxSeq, row.seq);
      if (row.type === "thread/tokenUsage/updated") {
        const parsed = usageEventRowSchema.safeParse(row);
        if (parsed.success) usageByTurn.set(parsed.data.turnId, parsed.data);
        continue;
      }
      const point = turnEventRowSchema.safeParse(row);
      if (!point.success) continue;
      if (point.data.type === "turn/started") started.set(point.data.turnId, point.data.createdAt);
      else completed.set(point.data.turnId, point.data.createdAt);
    }

    const usages = [...usageByTurn.values()].sort((a, b) => a.seq - b.seq);
    for (const usage of usages) {
      const startedAt = started.get(usage.turnId) ?? await findStartedAt(bb, threadId, usage.seq, usage.turnId);
      await saveUsage(bb, usage, startedAt, completed.get(usage.turnId) ?? usage.createdAt);
      changed = true;
    }
    const nextSeq = rows.length < EVENTS_PAGE_LIMIT ? signalSequence : maxSeq;
    await bb.storage.kv.set(sequenceKey(threadId), nextSeq);
    afterSeq = nextSeq;
    if (rows.length < EVENTS_PAGE_LIMIT) break;
  }

  if (changed) bb.realtime.publish("token-meter-changed", { threadId });
}

export default async function plugin(bb: BbPluginApi) {
  bb.rpc.register(rpcContract, {
    turn_usage: async ({ keys }) => Object.fromEntries(await Promise.all(keys.map(async (key) => {
      const separator = key.indexOf(":");
      if (separator <= 0 || separator === key.length - 1) return [key, null] as const;
      const threadId = key.slice(0, separator);
      const turnId = key.slice(separator + 1);
      const parsed = turnUsageSchema.safeParse(await bb.storage.kv.get<unknown>(turnKey(threadId, turnId)));
      return [key, parsed.success ? parsed.data : null] as const;
    }))),
    thread_usage: async ({ threadId }) => {
      const parsed = threadUsageSchema.safeParse(await bb.storage.kv.get<unknown>(summaryKey(threadId)));
      return parsed.success ? parsed.data : null;
    },
  });

  const pending = new Map<string, Promise<void>>();
  bb.events.on("experimental_thread.events", async ({ thread, sequence }) => {
    const previous = pending.get(thread.id) ?? Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(() => syncThread(bb, thread.id, sequence))
      .catch((cause: unknown) => {
        bb.log.warn(`token-meter sync failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      });
    pending.set(thread.id, current);
    try {
      await current;
    } finally {
      if (pending.get(thread.id) === current) pending.delete(thread.id);
    }
  });

  try {
    await pruneAll(bb);
  } catch (cause) {
    bb.log.warn(`token-meter prune failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}
