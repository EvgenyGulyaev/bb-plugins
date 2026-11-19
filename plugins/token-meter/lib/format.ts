function trimDecimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
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
}): string {
  const base = `↑${formatCompact(usage.input)} ↓${formatCompact(usage.output)} · cache ${formatCompact(usage.cached)}`;
  return usage.tokPerSec === undefined ? base : `${base} · ${trimDecimal(usage.tokPerSec)} ток/с`;
}

export function formatThreadText(usage: { total: number; averageTokPerSec?: number }): string {
  const base = `Σ ${formatCompact(usage.total)} токенов`;
  return usage.averageTokPerSec === undefined ? base : `${base} · ~${trimDecimal(usage.averageTokPerSec)} ток/с`;
}
