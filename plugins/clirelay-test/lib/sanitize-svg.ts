// Только безопасный inline SVG: без script/foreignObject, внешних ссылок,
// обработчиков событий и DOCTYPE. Всё остальное — null.
export const MAX_SVG_LENGTH = 8000;

const FORBIDDEN_ELEMENTS =
  /<\s*(script|foreignObject|iframe|object|embed|img|image|source|track|use|style|link|meta|base|form|input|button|audio|video|set|animate|animateTransform|animateMotion)\b/i;
const FORBIDDEN_MARKUP = /<!DOCTYPE|<!ENTITY|<\?xml/i;
// Границы: пробел, `/` после self-closing тега, кавычка или начало строки.
const EVENT_HANDLER = /(?:^|[\s/"'])on[a-z]+\s*=/i;
const SCRIPT_URL = /(?:javascript|vbscript|data)\s*:/i;
// Разрешён только внутренний url(#id); всё прочее (в т.ч. entity-encoded) — нет.
const EXTERNAL_URL = /url\s*\(\s*['"]?\s*[^#\s)]/i;
const CSS_EXPRESSION = /(?:expression|binding)\s*[:(]/i;
// href/xlink:href: значение в кавычках или без них; допускается только "#id".
const HREF_ATTRIBUTE = /(?:xlink:href|href)\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+)/gi;
// Любой src — внешний ресурс по определению.
const SRC_ATTRIBUTE = /\ssrc\s*=/i;

/** Вернуть безопасный markup или null, если SVG нельзя вставлять inline. */
export function sanitizeSvg(input: string): string | null {
  const svg = input.trim();
  if (!svg || svg.length > MAX_SVG_LENGTH) return null;
  if (!/^<svg[\s>]/i.test(svg)) return null;
  if (FORBIDDEN_ELEMENTS.test(svg) || FORBIDDEN_MARKUP.test(svg)) return null;
  if (EVENT_HANDLER.test(svg) || SCRIPT_URL.test(svg) || EXTERNAL_URL.test(svg) || CSS_EXPRESSION.test(svg)) return null;
  if (SRC_ATTRIBUTE.test(svg)) return null;
  for (const match of svg.matchAll(HREF_ATTRIBUTE)) {
    const value = match[1]!.replace(/^["']|["']$/g, "").trim();
    if (!value.startsWith("#")) return null;
  }
  return svg;
}
