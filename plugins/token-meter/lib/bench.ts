import type { BenchResult } from "./contract.js";

const PROMPT = "Перечисли через запятую числа от 1 до 2000 словами. Без вступления.";
const TIMEOUT_MS = 120_000;
const MAX_TOKEN_SEQUENCE = [150, 1_500, 150, 1_500] as const;

function failureMessage(cause: unknown, apiKey?: string): string {
  const raw = cause instanceof Error ? cause.message : String(cause);
  return apiKey ? raw.replaceAll(apiKey, "[secret]") : raw;
}

/**
 * Endpoint — пользовательская настройка, поэтому логин/пароль в URL отвергаем:
 * такой адрес утёк бы в тексты ошибок и в логи.
 */
function parseEndpoint(raw: string): string {
  const endpoint = raw.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("замер не выполнен: benchEndpoint не является URL");
  }
  if (url.username || url.password) {
    throw new Error("замер не выполнен: endpoint не должен содержать логин/пароль");
  }
  return endpoint;
}

/** Отмена вызывающим и таймаут запроса неразличимы по типу причины — различаем по внешнему сигналу. */
function abortMessage(cause: unknown, outer?: AbortSignal): string | null {
  const name = cause instanceof Error ? cause.name : "";
  if (name !== "TimeoutError" && name !== "AbortError") return null;
  return outer?.aborted ? "замер отменён" : "замер не выполнен: таймаут 120 с";
}

function requestSignal(outer?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  return outer ? AbortSignal.any([outer, timeout]) : timeout;
}

export async function benchmarkModel(input: {
  model: string;
  endpoint: string;
  apiKey?: string;
  /** Сигнал RPC-вызова: отмена освобождает single-flight на сервере. */
  signal?: AbortSignal;
}): Promise<BenchResult> {
  const endpoint = parseEndpoint(input.endpoint);
  const samples: BenchResult["samples"] = [];
  for (const maxTokens of MAX_TOKEN_SEQUENCE) {
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await fetch(`${endpoint}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: input.model,
          messages: [{ role: "user", content: PROMPT }],
          max_tokens: maxTokens,
          stream: false,
        }),
        signal: requestSignal(input.signal),
      });
    } catch (cause) {
      throw new Error(abortMessage(cause, input.signal) ?? `замер не выполнен: ${failureMessage(cause, input.apiKey)}`);
    }
    const durationMs = Date.now() - startedAt;
    if (!response.ok) throw new Error(`замер не выполнен: HTTP ${response.status}`);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (cause) {
      // Таймаут срабатывает и на чтении тела: это не «ответ не JSON».
      throw new Error(abortMessage(cause, input.signal) ?? "замер не выполнен: ответ не JSON");
    }
    const outputTokens = (payload as { usage?: { completion_tokens?: unknown } })?.usage?.completion_tokens;
    if (typeof outputTokens !== "number" || !Number.isFinite(outputTokens) || outputTokens < 0) {
      throw new Error("замер не выполнен: нет usage.completion_tokens");
    }
    samples.push({ maxTokens, outputTokens, durationMs });
  }

  const short = samples.filter((sample) => sample.maxTokens === 150);
  const long = samples.filter((sample) => sample.maxTokens === 1_500);
  const average = (rows: typeof samples, field: "outputTokens" | "durationMs") =>
    rows.reduce((sum, row) => sum + row[field], 0) / rows.length;
  const avgOut150 = average(short, "outputTokens");
  const avgOut1500 = average(long, "outputTokens");
  const avgMs150 = average(short, "durationMs");
  const avgMs1500 = average(long, "durationMs");
  const rate = (avgOut1500 - avgOut150) / ((avgMs1500 - avgMs150) / 1_000);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error("замер неустойчив: разница длин и времени не даёт положительную скорость");
  }
  const latencyMs = avgMs150 - avgOut150 / rate * 1_000;
  return {
    model: input.model,
    genTokPerSec: Math.round(rate * 10) / 10,
    latencyMs: Math.round(latencyMs),
    at: Date.now(),
    samples,
  };
}
