import type { TurnUsage } from "./contract.js";

type Benchmark = {
  model: string;
  genTokPerSec: number;
  latencyMs: number;
  at: number;
  samples: readonly unknown[];
};

function trimDecimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

function formatRate(value: number): string {
  return value >= 100 ? String(Math.round(value)) : String(Math.round(value * 10) / 10);
}

function formatDuration(durationMs: number): string {
  return `${trimDecimal(durationMs / 1_000)} с`;
}

/** Дата замера — в локальном времени пользователя, а не в UTC. */
export function formatBenchDate(at: number): string {
  const date = new Date(at);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function formatCompact(value: number): string {
  if (value < 1_000) return String(Math.round(value));
  const units = ["k", "M", "B"] as const;
  let scaled = value / 1_000;
  let unit = 0;
  while (unit < units.length - 1 && Number(scaled.toFixed(1)) >= 1_000) {
    scaled /= 1_000;
    unit += 1;
  }
  return trimDecimal(scaled) + units[unit];
}

export function formatTurnText(usage: {
  input: number;
  cached: number;
  output: number;
  tokPerSec?: number;
}, benchmark?: Benchmark | null): string {
  const base = `↑${formatCompact(usage.input)} ↓${formatCompact(usage.output)} · cache ${formatCompact(usage.cached)}`;
  const effective = usage.tokPerSec === undefined ? base : `${base} · ${formatRate(usage.tokPerSec)} ток/с (эфф.)`;
  return benchmark ? `${effective} · модель ~${Math.round(benchmark.genTokPerSec)}` : effective;
}

export function formatTurnTitle(usage: TurnUsage, benchmark?: Benchmark | null): string {
  const durations = [
    `Последний вызов: ${usage.durationMs == null ? "недоступна" : formatDuration(usage.durationMs)}`,
    ...(usage.turnDurationMs === undefined ? [] : [`Весь ход: ${formatDuration(usage.turnDurationMs)}`]),
  ].join(" · ");
  return [
    `Вход: ${usage.input}`,
    `Кеш: ${usage.cached}`,
    `Кеш чтение: ${usage.cacheRead ?? "не сообщено"}`,
    `Кеш запись: ${usage.cacheWrite ?? "не сообщено"}`,
    `Выход: ${usage.output}`,
    `Reasoning: ${usage.reasoning}`,
    `Всего за вызов: ${usage.total}`,
    durations,
    `Эффективная скорость последнего вызова: ${usage.tokPerSec === undefined ? "недоступна" : `${formatRate(usage.tokPerSec)} ток/с — выход ÷ время от конца последнего инструмента до конца хода; включает ожидание первого токена (обработка контекста, очередь, скрытое рассуждение)`}`,
    ...(benchmark ? [`Чистая генерация модели ${benchmark.model}: ~${Math.round(benchmark.genTokPerSec)} ток/с, задержка ~${(benchmark.latencyMs / 1_000).toFixed(1)} с (замер ${formatBenchDate(benchmark.at)})`] : []),
  ].join("\n");
}

export function formatThreadText(usage: { total: number; averageTokPerSec?: number }): string {
  const base = `Σ ${formatCompact(usage.total)} токенов`;
  return usage.averageTokPerSec === undefined ? base : `${base} · ~${formatRate(usage.averageTokPerSec)} ток/с (эфф.)`;
}
