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
  durationMs: z.number().positive().nullable(),
  tokPerSec: tokenCount.optional(),
  at: tokenCount,
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
export type TurnUsage = z.infer<typeof turnUsageSchema>;
export type ThreadUsage = z.infer<typeof threadUsageSchema>;

export const realtimePayloadSchema = z.object({ threadId: z.string().min(1) });

export const rpcContract = defineRpcContract({
  turn_usage: {
    input: z.object({ keys: z.array(z.string().min(3)).max(500) }).strict(),
    output: z.record(z.string(), turnUsageSchema.nullable()),
  },
  thread_usage: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: threadUsageSchema.nullable(),
  },
});
