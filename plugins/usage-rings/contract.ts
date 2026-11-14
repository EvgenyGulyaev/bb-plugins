import type { PluginRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const id = z.string().min(1).max(256);
export const preferencesSchema = z.array(z.object({ id, enabled: z.boolean() }).strict()).max(100)
  .refine(rows => new Set(rows.map(row => row.id)).size === rows.length, "Провайдеры не должны повторяться");
const windowSchema = z.object({ label: z.string(), usedPercent: z.number().finite(), resetsAt: z.string().nullable() });
const usageSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), windows: z.array(windowSchema), accountEmail: z.string().nullable(), planLabel: z.string().nullable() }),
  z.object({ status: z.enum(["not_installed", "unauthenticated", "expired", "error"]), message: z.string().optional() }),
]);
const artwork = {
  logoUrl: z.string().nullable().optional(),
  icon: z.union([z.string(), z.object({ glyph: z.string() })]).nullable().optional(),
  strings: z.object({ iconTint: z.object({ light: z.string(), dark: z.string() }).nullable().optional() }).nullable().optional(),
};
const accountSchema = z.object({ id, accountLabel: z.string().nullable().optional(), usage: usageSchema.nullable().optional() });
const resourceSchema = accountSchema.extend({ providerId: id, displayName: z.string(), ...artwork });
export const usageResponseSchema = z.object({ machines: z.array(z.object({
  id, displayName: z.string(), status: z.enum(["connected", "disconnected"]),
  error: z.string().nullable(), providers: z.array(resourceSchema),
})) });
const providerSchema = z.object({ id, displayName: z.string(), ...artwork, enabled: z.boolean(), accounts: z.array(accountSchema) });
export const overviewSchema = z.object({
  providers: z.array(providerSchema), preferences: preferencesSchema,
  machineName: z.string().nullable(), error: z.string().nullable(),
});
const hostInput = z.object({ hostId: id.nullable() }).strict();
export const resetCreditSchema = z.object({
  id, resetType: z.string(), status: z.string(), grantedAt: z.number().int().min(0).max(8640000000000),
  expiresAt: z.number().int().min(0).max(8640000000000).nullable(), title: z.string().nullable(), description: z.string().nullable(),
});
export const resetsSchema = z.object({
  accountId: id, email: z.string(), availableCount: z.number().int().nonnegative(),
  credits: z.array(resetCreditSchema).nullable(),
  windows: z.array(z.object({ label: z.string(), remaining: z.number(), resetsAt: z.number().nullable() })),
});
const resetAccount = z.object({ hostId: id.nullable(), accountId: id }).strict();
const consumeFields = {
  creditId: id, expectedAccountId: id, idempotencyKey: z.string().uuid(), confirmed: z.literal(true),
};
export const resetOutcomeSchema = z.enum(["reset", "nothingToReset", "noCredit", "alreadyRedeemed"]);
export const resetHostContract = {
  readResets: { input: z.object({ expectedEmail: z.string().min(1) }).strict(), output: resetsSchema },
  consumeReset: { input: z.object({ expectedEmail: z.string().min(1), ...consumeFields }).strict(), output: resetOutcomeSchema },
} satisfies PluginRpcContract;
export type Resets = z.infer<typeof resetsSchema>;
export type ResetCredit = z.infer<typeof resetCreditSchema>;
export function availableCredits(data: Resets, now = Date.now()) {
  return data.credits?.filter(c => c.status === "available" && (c.expiresAt === null || c.expiresAt * 1000 > now))
    .sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity)) ?? [];
}
export const contract = {
  overview: { input: hostInput, output: overviewSchema, tags: () => ["usage-rings"] },
  savePreferences: { input: preferencesSchema, output: preferencesSchema },
  refresh: { input: hostInput, output: z.null() },
  resets: { input: resetAccount, output: resetsSchema },
  consumeReset: { input: resetAccount.extend(consumeFields).strict(), output: resetOutcomeSchema },
} satisfies PluginRpcContract;
export type Overview = z.infer<typeof overviewSchema>;
export type Provider = Overview["providers"][number];
export type Account = Provider["accounts"][number];
