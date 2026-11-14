import { defineRpcContract } from "@get-bb/plugin-sdk";
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
export const contract = defineRpcContract({
  overview: { input: hostInput, output: overviewSchema, tags: () => ["usage-rings"] },
  savePreferences: { input: preferencesSchema, output: preferencesSchema },
  refresh: { input: hostInput, output: z.null() },
});
export type Overview = z.infer<typeof overviewSchema>;
export type Provider = Overview["providers"][number];
export type Account = Provider["accounts"][number];
