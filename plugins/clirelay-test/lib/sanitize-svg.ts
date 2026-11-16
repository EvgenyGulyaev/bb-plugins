// Только безопасный inline SVG: без script/foreignObject, внешних ссылок,
// обработчиков событий и DOCTYPE. Всё остальное — null.
export const MAX_SVG_LENGTH = 8000;

const FORBIDDEN_ELEMENTS =
  /<\s*(script|foreignObject|iframe|object|embed|image|use|style|link|meta|base|form|input|button|audio|video)\b/i;
const FORBIDDEN_MARKUP = /<!DOCTYPE|<!ENTITY|<\?xml/i;
const EVENT_HANDLER = /\son[a-z]+\s*=/i;
const SCRIPT_URL = /(?:javascript|vbscript)\s*:/i;
const EXTERNAL_URL = /url\s*\(\s*['"]?\s*(?!#)/i;
const HREF_ATTRIBUTE = /(?:xlink:href|href)\s*=\s*("[^"]*"|'[^']*')/gi;

/** Вернуть безопасный markup или null, если SVG нельзя вставлять inline. */
export function sanitizeSvg(input: string): string | null {
  const svg = input.trim();
  if (!svg || svg.length > MAX_SVG_LENGTH) return null;
  if (!/^<svg[\s>]/i.test(svg)) return null;
  if (FORBIDDEN_ELEMENTS.test(svg) || FORBIDDEN_MARKUP.test(svg)) return null;
  if (EVENT_HANDLER.test(svg) || SCRIPT_URL.test(svg) || EXTERNAL_URL.test(svg)) return null;
  for (const match of svg.matchAll(HREF_ATTRIBUTE)) {
    const value = match[1]!.slice(1, -1).trim();
    if (!value.startsWith("#")) return null;
  }
  return svg;
}
