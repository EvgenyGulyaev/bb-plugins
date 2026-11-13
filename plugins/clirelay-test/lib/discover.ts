export class DiscoverError extends Error {}

// pi резолвит literal, $ENV/${ENV} и !command. ponytail: !command не исполняем
// (безопасность); апгрейд — явное разрешение пользователя на команду.
export function resolveApiKey(raw: unknown, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  if (raw.startsWith("!")) throw new DiscoverError("ключ-команда (!…) не поддерживается для списка моделей");
  if (raw.startsWith("$$") || raw.startsWith("$!")) return raw.slice(1);
  const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$|^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(raw);
  if (match) {
    const name = (match[1] ?? match[2])!;
    const value = env[name];
    if (!value) throw new DiscoverError(`переменная ${name} не задана в окружении`);
    return value;
  }
  return raw;
}

export async function discoverModels(
  baseUrl: string,
  apiKey: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
  } catch (cause) {
    if (cause instanceof Error && cause.name === "AbortError") throw new DiscoverError("таймаут 10с: эндпоинт не ответил");
    throw new DiscoverError("не удалось соединиться с эндпоинтом");
  }
  if (!response.ok) throw new DiscoverError(`эндпоинт ответил HTTP ${response.status}`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new DiscoverError("эндпоинт вернул не JSON");
  }
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  const items = Array.isArray(body) ? body : record && Array.isArray(record.data) ? record.data : null;
  if (!items) throw new DiscoverError("в ответе нет списка моделей (ожидался { data: [...] })");
  const ids = items
    .map((item) =>
      typeof item === "string"
        ? item
        : item && typeof item === "object" && typeof (item as Record<string, unknown>).id === "string"
          ? ((item as Record<string, unknown>).id as string)
          : null,
    )
    .filter((id): id is string => !!id);
  return [...new Set(ids)].sort().slice(0, 1000);
}
