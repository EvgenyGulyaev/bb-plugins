import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const tokenCount = z.number().finite().nonnegative();

const usageValuesSchema = z.object({
  inputTokens: tokenCount,
  cachedInputTokens: tokenCount,
  cacheReadInputTokens: tokenCount.optional(),
  cacheWriteInputTokens: tokenCount.optional(),
  outputTokens: tokenCount,
  reasoningOutputTokens: tokenCount,
  totalTokens: tokenCount,
});

export const tokenUsageSchema = z.object({
  last: usageValuesSchema,
  total: usageValuesSchema,
  modelContextWindow: tokenCount.nullable(),
  promptCacheTtlMs: tokenCount.optional(),
});

const eventScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thread") }),
  z.object({ kind: z.literal("turn"), turnId: z.string().min(1) }),
]);

const eventBaseShape = {
  threadId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  createdAt: tokenCount,
  scope: eventScopeSchema.optional(),
  /** Compatibility fallback: bb puts the turn on `scope`, not on the row. */
  turnId: z.string().min(1).optional(),
};

type ScopeBearing = { scope?: z.infer<typeof eventScopeSchema>; turnId?: string };

function scopeTurnId(row: ScopeBearing): string | undefined {
  return row.scope?.kind === "turn" ? row.scope.turnId : row.turnId;
}

const requireTurnScope = { message: "event has no turn scope", path: ["scope"] };

export const usageEventRowSchema = z.object({
  type: z.literal("thread/tokenUsage/updated"),
  ...eventBaseShape,
  data: z.object({ tokenUsage: tokenUsageSchema }),
})
  .refine((row) => scopeTurnId(row) !== undefined, requireTurnScope)
  .transform((row) => ({ ...row, turnId: scopeTurnId(row) as string }));

/** `turn/started` and `turn/completed`: only their timestamps and turn id matter. */
export const turnEventRowSchema = z.object({
  type: z.enum(["turn/started", "turn/completed"]),
  ...eventBaseShape,
  data: z.unknown().optional(),
})
  .refine((row) => scopeTurnId(row) !== undefined, requireTurnScope)
  .transform((row) => ({ ...row, turnId: scopeTurnId(row) as string }));

/**
 * `item/started` and `item/completed`. `itemKind` comes from `data.item.type`
 * (bb's own DB also keeps it in an `item_kind` column).
 */
export const itemEventRowSchema = z.object({
  type: z.enum(["item/started", "item/completed"]),
  ...eventBaseShape,
  itemKind: z.string().min(1).optional(),
  data: z.object({ item: z.object({ type: z.string().min(1) }).loose().optional() }).optional(),
})
  .refine((row) => scopeTurnId(row) !== undefined, requireTurnScope)
  .transform((row) => ({
    ...row,
    turnId: scopeTurnId(row) as string,
    itemKind: row.data?.item?.type ?? row.itemKind,
  }));

export const turnUsageSchema = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  input: tokenCount,
  cached: tokenCount,
  cacheRead: tokenCount.optional(),
  cacheWrite: tokenCount.optional(),
  output: tokenCount,
  reasoning: tokenCount,
  total: tokenCount,
  /** Окно последнего вызова модели; отсутствует, когда окно неизвестно (старые записи хранят null). */
  durationMs: z.union([z.number().positive(), z.null()]).optional(),
  /** Весь ход: turn/completed − turn/started. */
  turnDurationMs: z.number().positive().optional(),
  tokPerSec: tokenCount.optional(),
  model: z.string().min(1).optional(),
  providerId: z.string().min(1).optional(),
  at: tokenCount,
});

export const benchSampleSchema = z.object({
  maxTokens: z.number().int().positive(),
  outputTokens: tokenCount,
  durationMs: tokenCount,
});

export const benchResultSchema = z.object({
  model: z.string().min(1),
  genTokPerSec: z.number().finite().positive(),
  latencyMs: z.number().finite(),
  at: tokenCount,
  samples: z.array(benchSampleSchema).length(4),
});

export const threadUsageSchema = z.object({
  threadId: z.string().min(1),
  total: tokenCount,
  turns: z.number().int().nonnegative(),
  averageTokPerSec: tokenCount.optional(),
  modelContextWindow: tokenCount.nullable(),
});

export type TokenUsage = z.infer<typeof tokenUsageSchema>;
export type UsageEventRow = z.infer<typeof usageEventRowSchema>;
export type TurnEventRow = z.infer<typeof turnEventRowSchema>;
export type ItemEventRow = z.infer<typeof itemEventRowSchema>;
export type TurnUsage = z.infer<typeof turnUsageSchema>;
export type ThreadUsage = z.infer<typeof threadUsageSchema>;
export type BenchResult = z.infer<typeof benchResultSchema>;

/** RPC cache tag shared by both methods and by the server's invalidation. */
export function threadTag(threadId: string): string {
  return `thread:${threadId}`;
}

function keyThreadTag(key: string): readonly string[] {
  const separator = key.indexOf(":");
  return separator > 0 ? [threadTag(key.slice(0, separator))] : [];
}

export const rpcContract = defineRpcContract({
  turn_usage: {
    input: z.object({ keys: z.array(z.string().min(3)).max(500) }).strict(),
    output: z.record(z.string(), turnUsageSchema.nullable()),
    keyTags: (key: string) => keyThreadTag(key),
  },
  thread_usage: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: threadUsageSchema.nullable(),
    tags: (input: { threadId: string }) => [threadTag(input.threadId)],
  },
  bench_model: {
    input: z.object({ model: z.string().min(1) }).strict(),
    output: benchResultSchema,
  },
  bench_list: {
    input: z.null(),
    output: z.object({
      models: z.array(z.string().min(1)),
      results: z.array(benchResultSchema),
      benchEnabled: z.boolean(),
      hasEndpoint: z.boolean(),
    }),
    tags: () => ["bench"],
  },
});
