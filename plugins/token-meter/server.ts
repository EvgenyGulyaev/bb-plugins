import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  itemEventRowSchema,
  rpcContract,
  threadTag,
  threadUsageSchema,
  turnEventRowSchema,
  turnUsageSchema,
  usageEventRowSchema,
  type ItemEventRow,
  type TurnUsage,
  type UsageEventRow,
} from "./lib/contract.js";
import { makeTurnUsage, retainTurns, summarizeTurns } from "./lib/usage.js";

const EVENT_TYPES = ["thread/tokenUsage/updated", "turn/started", "turn/completed"] as const;
const ITEM_EVENT_TYPES = ["item/started", "item/completed"] as const;
/** Лимит API bb: threads.events.list отвечает HTTP 400 на limit > 100. */
const EVENTS_PAGE_LIMIT = 100;
/** Сколько item-событий перед usage-событием просматриваем в поисках последнего инструмента. */
const TOOL_LOOKBACK = 10;
const STARTED_LOOKBACK = 20;
const TURN_PREFIX = "token-meter:turn:";
const THREAD_PREFIX = "token-meter:thread:";
const SEQ_PREFIX = "token-meter:seq:";
/** Айтемы вывода: последний вызов модели начинается после последнего НЕ такого айтема. */
const MODEL_ITEM_KINDS = new Set(["agentMessage", "reasoning"]);

type Kv = BbPluginApi["storage"]["kv"];

function pageLimit(size: number): string {
  return String(Math.min(size, EVENTS_PAGE_LIMIT));
}

function turnKey(threadId: string, turnId: string): string {
  return `${TURN_PREFIX}${threadId}:${turnId}`;
}

function turnPrefix(threadId: string): string {
  return `${TURN_PREFIX}${threadId}:`;
}

function sequenceKey(threadId: string): string {
  return `${SEQ_PREFIX}${threadId}`;
}

function summaryKey(threadId: string): string {
  return `${THREAD_PREFIX}${threadId}`;
}

async function readTurns(kv: Kv, threadId: string): Promise<TurnUsage[]> {
  const keys = await kv.list(turnPrefix(threadId));
  const rows = await Promise.all(keys.map((key) => kv.get<unknown>(key)));
  return rows.flatMap((row) => {
    const parsed = turnUsageSchema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
}

async function writeSummary(bb: BbPluginApi, threadId: string, turns: readonly TurnUsage[]): Promise<void> {
  if (turns.length === 0) {
    await bb.storage.kv.delete(summaryKey(threadId));
    return;
  }
  const previous = threadUsageSchema.safeParse(await bb.storage.kv.get<unknown>(summaryKey(threadId)));
  const modelContextWindow = previous.success ? previous.data.modelContextWindow : null;
  await bb.storage.kv.set(summaryKey(threadId), summarizeTurns(threadId, turns, modelContextWindow));
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
  windowStartedAt: number | null,
  turnStartedAt: number | null,
  endedAt: number,
): Promise<void> {
  const { threadId, turnId } = event;
  const record = makeTurnUsage({
    threadId,
    turnId,
    tokenUsage: event.data.tokenUsage,
    windowStartedAt,
    endedAt,
    turnStartedAt,
    at: event.createdAt,
  });
  await bb.storage.kv.set(turnKey(threadId, turnId), record);
  const kept = await pruneThread(bb.storage.kv, threadId, Date.now());
  await bb.storage.kv.set(summaryKey(threadId), summarizeTurns(
    threadId,
    kept,
    event.data.tokenUsage.modelContextWindow,
  ));
}

async function pruneAll(bb: BbPluginApi): Promise<void> {
  const now = Date.now();
  const kept = new Map<string, TurnUsage[]>();
  for (const key of await bb.storage.kv.list(TURN_PREFIX)) {
    const parsed = turnUsageSchema.safeParse(await bb.storage.kv.get<unknown>(key));
    if (!parsed.success) {
      await bb.storage.kv.delete(key);
      continue;
    }
    const rows = kept.get(parsed.data.threadId) ?? [];
    rows.push(parsed.data);
    kept.set(parsed.data.threadId, rows);
  }
  for (const [threadId, rows] of kept) {
    const retained = retainTurns(rows, now);
    await Promise.all(retained.removed.map((row) => bb.storage.kv.delete(turnKey(threadId, row.turnId))));
    kept.set(threadId, retained.kept);
    await writeSummary(bb, threadId, retained.kept);
  }
  for (const prefix of [THREAD_PREFIX, SEQ_PREFIX]) {
    for (const key of await bb.storage.kv.list(prefix)) {
      if ((kept.get(key.slice(prefix.length)) ?? []).length > 0) continue;
      await bb.storage.kv.delete(key);
    }
  }
}

async function findStartedAt(
  bb: BbPluginApi,
  threadId: string,
  usageSeq: number,
  turnId: string,
): Promise<number | null> {
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

/**
 * Конец последнего инструмента этого хода. `tokenUsage.last` — usage последнего
 * вызова модели, поэтому окно вызова начинается там, а не в `turn/started`
 * (иначе в знаменатель попадают все инструменты хода).
 */
async function findToolCompletedAt(
  bb: BbPluginApi,
  threadId: string,
  usageSeq: number,
  turnId: string,
): Promise<number | null> {
  const rows = await bb.sdk.threads.events.list({
    threadId,
    types: ITEM_EVENT_TYPES,
    beforeSeq: String(usageSeq),
    order: "desc",
    limit: pageLimit(TOOL_LOOKBACK),
  });
  for (const row of rows) {
    const parsed = itemEventRowSchema.safeParse(row);
    if (!parsed.success) continue;
    if (parsed.data.turnId !== turnId) break;
    if (parsed.data.type !== "item/completed" || !isToolItem(parsed.data)) continue;
    return parsed.data.createdAt;
  }
  return null;
}

function isToolItem(row: ItemEventRow): boolean {
  return row.itemKind !== undefined && !MODEL_ITEM_KINDS.has(row.itemKind);
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
      const turnStartedAt = started.get(usage.turnId) ?? await findStartedAt(bb, threadId, usage.seq, usage.turnId);
      const endedAt = completed.get(usage.turnId) ?? usage.createdAt;
      const toolCompletedAt = await findToolCompletedAt(bb, threadId, usage.seq, usage.turnId);
      await saveUsage(bb, usage, toolCompletedAt ?? turnStartedAt, turnStartedAt, endedAt);
      changed = true;
    }
    const nextSeq = rows.length < EVENTS_PAGE_LIMIT ? Math.max(signalSequence, maxSeq) : maxSeq;
    await bb.storage.kv.set(sequenceKey(threadId), nextSeq);
    afterSeq = nextSeq;
    if (rows.length < EVENTS_PAGE_LIMIT) break;
  }

  if (changed) bb.rpc.experimental_invalidate([threadTag(threadId)]);
}

async function dropThread(bb: BbPluginApi, threadId: string): Promise<void> {
  const keys = await bb.storage.kv.list(turnPrefix(threadId));
  await Promise.all(keys.map((key) => bb.storage.kv.delete(key)));
  await bb.storage.kv.delete(sequenceKey(threadId));
  await bb.storage.kv.delete(summaryKey(threadId));
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

  try {
    await pruneAll(bb);
  } catch (cause) {
    bb.log.warn(`token-meter prune failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

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

  bb.events.on("thread.deleted", async ({ thread }) => {
    try {
      await dropThread(bb, thread.id);
      bb.rpc.experimental_invalidate([threadTag(thread.id)]);
    } catch (cause) {
      bb.log.warn(`token-meter drop failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  });
}