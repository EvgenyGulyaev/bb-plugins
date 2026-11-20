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

export type InputModality = "text" | "image";
export type ReasoningLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Только эти поля читаем из GET /models; всё остальное игнорируем. */
export interface DiscoveredModel {
  id: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: InputModality[];
  supportedReasoningLevels?: ReasoningLevel[];
}

const CONTEXT_LIMIT = 10_000_000;
const MAX_TOKENS_LIMIT = 1_000_000;
const LEVELS = new Set<string>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

// Число из API: только finite positive safe integer в разумных границах. Не клампим.
function safePositive(value: unknown, limit: number): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= limit ? value : undefined;
}

// Alias-пара: одно валидное → оно; оба равны → оно; оба разные → unreliable (undefined).
function aliased(a: unknown, b: unknown, limit: number): number | undefined {
  const left = safePositive(a, limit);
  const right = safePositive(b, limit);
  if (left !== undefined && right !== undefined) return left === right ? left : undefined;
  return left ?? right;
}

function modalities(value: unknown): InputModality[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: InputModality[] = [];
  for (const item of value) {
    if ((item === "text" || item === "image") && !result.includes(item)) result.push(item);
  }
  return result.length > 0 ? result : undefined;
}

// Либо весь массив из известных уровней, либо поле игнорируется целиком.
function reasoningLevels(value: unknown): ReasoningLevel[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every((item) => typeof item === "string" && LEVELS.has(item))) return undefined;
  return value as ReasoningLevel[];
}

function metadataFor(item: Record<string, unknown>): Omit<DiscoveredModel, "id"> {
  const metadata: Omit<DiscoveredModel, "id"> = {};
  const contextWindow = aliased(item.context_window, item.max_context_window, CONTEXT_LIMIT);
  if (contextWindow !== undefined) metadata.contextWindow = contextWindow;
  const maxTokens = aliased(item.max_tokens, item.max_output_tokens, MAX_TOKENS_LIMIT);
  if (maxTokens !== undefined) metadata.maxTokens = maxTokens;
  const input = modalities(item.input_modalities);
  if (input) metadata.input = input;
  const levels = reasoningLevels(item.supported_reasoning_levels);
  if (levels) metadata.supportedReasoningLevels = levels;
  return metadata;
}

/** Детальный парсер GET /models: sorted/deduped id + whitelist metadata. */
export async function discoverModelDetails(
  baseUrl: string,
  apiKey: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<DiscoveredModel[]> {
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
  const models = new Map<string, DiscoveredModel>();
  for (const item of items) {
    const id = typeof item === "string" ? item : item && typeof item === "object" && typeof (item as Record<string, unknown>).id === "string" ? ((item as Record<string, unknown>).id as string) : null;
    if (!id || models.has(id)) continue; // первое вхождение id побеждает
    models.set(id, { id, ...(item && typeof item === "object" ? metadataFor(item as Record<string, unknown>) : {}) });
  }
  return [...models.values()].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)).slice(0, 1000);
}

/** Старый контракт: только список id. */
export async function discoverModels(
  baseUrl: string,
  apiKey: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  return (await discoverModelDetails(baseUrl, apiKey, fetchImpl)).map((model) => model.id);
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
