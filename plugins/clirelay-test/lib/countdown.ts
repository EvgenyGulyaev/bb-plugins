// Countdown до сброса окна квоты: 3d2h / 5h12m / 40m.
export function countdown(resetAt?: string | null): string | null {
  if (!resetAt) return null;
  const ms = new Date(resetAt).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  return days > 0 ? `${days}d${hours % 24}h` : hours > 0 ? `${hours}h${minutes % 60}m` : `${minutes}m`;
}

export function formatWindowDuration(seconds?: number | null): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds % 86400 === 0) return `${seconds / 86400} дн`;
  if (seconds % 3600 === 0) return `${seconds / 3600} ч`;
  if (seconds % 60 === 0) return `${seconds / 60} мин`;
  return `${seconds} сек`;
}

export function quotaResetFallback(quota: {
  percent?: number | null;
  reset_at?: string | null;
  window_seconds?: number | null;
}): { text: string; title: string } | null {
  if (quota.reset_at) return null;
  const duration = formatWindowDuration(quota.window_seconds);
  if (duration === null) return null;
  return {
    text: quota.percent === 100 ? "окно не начато" : "сброс неизвестен",
    title: `relay не сообщает сброс, пока окно не начато; длина окна ${duration}`,
  };
}
