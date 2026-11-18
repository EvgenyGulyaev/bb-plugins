import { describe, expect, it } from "vitest";
import { PROVIDER_LOGOS, providerLogo } from "./provider-logos";

describe("provider logos", () => {
  it("ships the four vendored logos", () => {
    expect(Object.keys(PROVIDER_LOGOS).sort()).toEqual(["claude", "gpt", "grok", "kimi"]);
  });

  it("draws with currentColor and a 24 unit viewBox", () => {
    for (const svg of Object.values(PROVIDER_LOGOS)) {
      expect(svg).toContain('viewBox="0 0 24 24"');
      expect(svg).toContain("currentColor");
      expect(svg.startsWith("<svg")).toBe(true);
      expect(svg.endsWith("</svg>")).toBe(true);
    }
  });

  it("contains no script, event handler, href or foreignObject", () => {
    for (const svg of Object.values(PROVIDER_LOGOS)) {
      expect(svg).not.toMatch(/<script/i);
      expect(svg).not.toMatch(/\son[a-z]+\s*=/i);
      expect(svg).not.toMatch(/\bhref\s*=/i);
      expect(svg).not.toMatch(/<foreignObject/i);
      expect(svg).not.toMatch(/<use\b/i);
      expect(svg).not.toMatch(/url\(/i);
    }
  });

  it("resolves artwork per provider", () => {
    expect(providerLogo("kimi")).toBe(PROVIDER_LOGOS.kimi);
    expect(providerLogo("claude")).toBe(PROVIDER_LOGOS.claude);
    expect(providerLogo("grok")).toBe(PROVIDER_LOGOS.grok);
    expect(providerLogo("gpt")).toBe(PROVIDER_LOGOS.gpt);
    expect(providerLogo(null)).toBeNull();
    expect(providerLogo("gemini")).toBeNull();
  });
});
