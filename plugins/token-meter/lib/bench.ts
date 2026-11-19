import type { BenchResult } from "./contract.js";

const PROMPT = "Перечисли через запятую числа от 1 до 2000 словами. Без вступления.";
const TIMEOUT_MS = 120_000;
const MAX_TOKEN_SEQUENCE = [150, 1_500, 150, 1_500] as const;

function failureMessage(cause: unknown, apiKey?: string): string {
  const raw = cause instanceof Error ? cause.message : String(cause);
  return apiKey ? raw.replaceAll(apiKey, "[secret]") : raw;
}

export async function benchmarkModel(input: {
  model: string;
  endpoint: string;
  apiKey?: string;
}): Promise<BenchResult> {
  const endpoint = input.endpoint.replace(/\/+$/, "");
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
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (cause) {
      const name = cause instanceof Error ? cause.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        throw new Error("замер не выполнен: таймаут 120 с");
      }
      throw new Error(`замер не выполнен: ${failureMessage(cause, input.apiKey)}`);
    }
    const durationMs = Date.now() - startedAt;
    if (!response.ok) throw new Error(`замер не выполнен: HTTP ${response.status}`);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("замер не выполнен: ответ не JSON");
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
