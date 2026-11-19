export function formatUsd(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100) >= 100000 ? `$${(value / 1000).toFixed(1)}k` : `$${value.toFixed(2)}`;
}
