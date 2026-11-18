import { relayOrigin, type RelayAccount } from "./relay-accounts";
import type { RingsSource } from "./rings";

// Кольца переиспользуют существующие RPC панели: `providers_list` даёт адреса,
// `relay_accounts` — квоты. Нового серверного похода за квотами нет.
export interface RingsRpc {
  call(method: string, input?: unknown): Promise<unknown>;
}

export interface RingsSourcesResult {
  sources: RingsSource[];
  error: string | null;
}

// Несколько провайдеров pi могут сидеть на одном адресе, но аккаунты relay у
// него общие — опрашиваем адрес один раз, по первому провайдеру группы.
export async function loadRingsSources(rpc: RingsRpc): Promise<RingsSourcesResult> {
  let providers: Array<{ id: string; baseUrl: string }>;
  try {
    ({ providers } = (await rpc.call("providers_list")) as { providers: Array<{ id: string; baseUrl: string }> });
  } catch (cause) {
    return { sources: [], error: message(cause) };
  }
  // Только id и адрес: остальной вид провайдера кольцам не нужен.
  const byBaseUrl = new Map<string, string>();
  for (const provider of providers) {
    if (provider.baseUrl && !byBaseUrl.has(provider.baseUrl)) byBaseUrl.set(provider.baseUrl, provider.id);
  }
  const sources: RingsSource[] = [];
  let error: string | null = null;
  for (const [baseUrl, providerId] of byBaseUrl) {
    try {
      const result = (await rpc.call("relay_accounts", { providerId })) as {
        items: RelayAccount[];
        error?: string;
      };
      if (result.error) error ??= result.error;
      sources.push({ origin: relayOrigin(baseUrl), accounts: result.items });
    } catch (cause) {
      error ??= message(cause);
    }
  }
  return { sources, error };
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
