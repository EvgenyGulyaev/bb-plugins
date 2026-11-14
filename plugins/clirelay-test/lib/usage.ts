import { z } from "zod";
import { DiscoverError } from "./discover";

// Публичный usage API clirelay (codeProxy): POST {origin}/v0/management/public/usage/summary.
const periodSchema = z.object({
  period: z.enum(["5h", "day", "week", "month"]),
  limit: z.number(),
  used: z.number(),
  remaining: z.number(),
  window_start: z.string().optional(),
  resets_at: z.string().optional(),
});

const scopeSchema = z.object({
  scope: z.enum(["account", "key"]),
  "period-spending": z.array(periodSchema).default([]),
  "daily-spending-used": z.number().default(0),
  "lifetime-spending-used": z.number().default(0),
});

const limitsSchema = z.object({
  "daily-limit": z.number().optional(),
  "daily-used": z.number().optional(),
  "total-quota": z.number().optional(),
  "total-used": z.number().optional(),
  "spending-limit": z.number().optional(),
  "spending-used": z.number().optional(),
  "daily-spending-limit": z.number().optional(),
  "daily-spending-used": z.number().optional(),
});

export const usageSummarySchema = z.object({
  found: z.boolean(),
  range: z.string().default(""),
  stats: z.object({ total_calls: z.number().default(0), quota_cost: z.number().default(0) }).default({ total_calls: 0, quota_cost: 0 }),
  limits: limitsSchema.nullable().optional(),
  "quota-scopes": z.array(scopeSchema).default([]),
});
export type UsageSummary = z.infer<typeof usageSummarySchema>;

// ponytail: origin = baseUrl без хвостового /v1; апгрейд — явная настройка origin,
// если relay когда-нибудь переедет на другой префикс.
export function relayOrigin(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

export async function fetchUsageSummary(
  baseUrl: string,
  apiKey: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<UsageSummary> {
  const url = `${relayOrigin(baseUrl)}/v0/management/public/usage/summary`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: apiKey ?? "" }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (cause) {
    if (cause instanceof Error && cause.name === "AbortError") throw new DiscoverError("таймаут 10с: relay не ответил");
    throw new DiscoverError("не удалось соединиться с relay");
  }
  if (!response.ok) throw new DiscoverError(`relay ответил HTTP ${response.status}`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new DiscoverError("relay вернул не JSON");
  }
  const parsed = usageSummarySchema.safeParse(body);
  if (!parsed.success) throw new DiscoverError("неожиданный формат usage summary");
  return parsed.data;
}
