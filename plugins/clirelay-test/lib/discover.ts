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

export interface ModelTestResult { ok: boolean; latencyMs: number; detail: string }

// Текст ошибки эндпоинта может содержать URL — вырезаем и режем длину.
function sanitizeDetail(text: string): string {
  let message = text;
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown }; message?: unknown };
    const inner = parsed?.error?.message ?? parsed?.message;
    if (typeof inner === "string") message = inner;
  } catch { /* не JSON — берём как есть */ }
  return message.replace(/https?:\/\/\S+/g, "[url]").slice(0, 200);
}

// Минимальный реальный запрос к модели: работает ли она вообще.
// ponytail: v1 только openai-completions (/chat/completions); апгрейд —
// ветки под openai-responses (/responses) и anthropic-messages (/messages).
export async function testModel(
  baseUrl: string,
  apiKey: string | undefined,
  modelId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelTestResult> {
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const started = Date.now();
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model: modelId, messages: [{ role: "user", content: "Reply with OK" }], max_tokens: 8, stream: false }),
      signal: AbortSignal.timeout(30_000),
    });
    const latencyMs = Date.now() - started;
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return { ok: false, latencyMs, detail: `HTTP ${response.status}${text ? `: ${sanitizeDetail(text)}` : ""}` };
    }
    const body = (await response.json().catch(() => null)) as { choices?: Array<{ message?: { content?: unknown } }> } | null;
    const content = body?.choices?.[0]?.message?.content;
    return { ok: true, latencyMs, detail: typeof content === "string" && content ? content.slice(0, 120) : "ответ получен" };
  } catch (cause) {
    const latencyMs = Date.now() - started;
    if (cause instanceof Error && cause.name === "AbortError") return { ok: false, latencyMs, detail: "таймаут 30с: модель не ответила" };
    return { ok: false, latencyMs, detail: "не удалось соединиться с эндпоинтом" };
  }
}
