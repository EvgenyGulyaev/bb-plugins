// Русские лейблы квот: словарь известных label + разбор ключей relay.
const LABEL_DICT: Record<string, string> = {
  "gemini models": "Модели Gemini",
  "claude and gpt models": "Модели Claude и GPT",
};

const TOKEN_RU: Record<string, string> = {
  code: "Код",
  weekly: "неделя",
  week: "неделя",
  daily: "день",
  day: "день",
  monthly: "месяц",
  month: "месяц",
  limit: "лимит",
};

const SKIP_TOKENS = new Set(["m", "quota"]);

export function quotaLabel(quota: { quota_key: string; quota_label?: string }): string {
  const label = quota.quota_label?.trim();
  // relay иногда шлёт ключ и в quota_label — такие «лейблы» разбираем как ключи
  const labelIsKey = !!label && !/\s/.test(label) && /[._]/.test(label);
  if (label && !labelIsKey) {
    const hours = /^(\d+)-hour limit$/i.exec(label);
    if (hours) return `Лимит ${hours[1]} ч`;
    const dayLimit = /^(\d+)-day limit$/i.exec(label);
    if (dayLimit) return `Лимит ${dayLimit[1]} дн`;
    const dayNamed = /^(\d+)-day (.+)$/i.exec(label);
    if (dayNamed) return `${dayNamed[1]} дн · ${dayNamed[2]}`;
    return LABEL_DICT[label.toLowerCase()] ?? label;
  }
  const source = labelIsKey ? label! : quota.quota_key;
  const tokens = source.toLowerCase().split(/[._\-]+/).filter((token) => token && !SKIP_TOKENS.has(token));
  const parts = tokens.map((token) => {
    if (TOKEN_RU[token]) return TOKEN_RU[token];
    if (/^\d+h$/.test(token)) return token.replace(/h$/, " ч");
    if (/^\d+d$/.test(token)) return token.replace(/d$/, " дн");
    return token.charAt(0).toUpperCase() + token.slice(1);
  });
  return parts.length ? parts.join(" · ") : source;
}
