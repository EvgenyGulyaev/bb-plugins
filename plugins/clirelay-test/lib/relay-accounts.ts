import { z } from "zod";
import { DiscoverError } from "./discover";

// Management API clirelay (codeProxy): GET {origin}/v0/management/ai-accounts/status.
const quotaSchema = z.object({
  quota_key: z.string(),
  quota_label: z.string().optional(),
  percent: z.number().nullable().optional(),
  reset_at: z.string().optional(),
  window_seconds: z.number().optional(),
  used_cost_usd: z.number().optional(),
});

export const relayAccountSchema = z.object({
  auth_index: z.string(),
  provider: z.string().optional(),
  plan_type: z.string().nullable().optional(),
  restriction_summary: z.string().nullable().optional(),
  health_status: z.string().optional(),
  quotas: z.array(quotaSchema).default([]),
  usage: z
    .object({
      success_rate: z.number().optional(),
      request_total: z.number().optional(),
      cost_total: z.number().optional(),
    })
    .nullable()
    .optional(),
});
export type RelayAccount = z.infer<typeof relayAccountSchema>;

const snapshotSchema = z.object({ items: z.array(relayAccountSchema).default([]) });

// ponytail: origin = baseUrl без хвостового /v1; апгрейд — явная настройка origin.
export function relayOrigin(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

export async function fetchRelayAccounts(
  baseUrl: string,
  managementKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RelayAccount[]> {
  const url = `${relayOrigin(baseUrl)}/v0/management/ai-accounts/status`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${managementKey}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (cause) {
    if (cause instanceof Error && cause.name === "AbortError") throw new DiscoverError("таймаут 10с: relay не ответил");
    throw new DiscoverError("не удалось соединиться с relay");
  }
  if (response.status === 401 || response.status === 403) throw new DiscoverError("management key неверный или не задан");
  if (!response.ok) throw new DiscoverError(`relay ответил HTTP ${response.status}`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new DiscoverError("relay вернул не JSON");
  }
  const parsed = snapshotSchema.safeParse(body);
  if (!parsed.success) throw new DiscoverError("неожиданный формат ai-accounts status");
  return parsed.data.items;
}
