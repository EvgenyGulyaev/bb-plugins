import { describe, expect, it } from "vitest";
import {
  RING_PER_ROW_DEFAULT,
  RING_PER_ROW_MAX,
  RING_PER_ROW_MIN,
  RING_SIZE_DEFAULT,
  RING_SIZE_MAX,
  RING_SIZE_MIN,
  RINGS_KV_KEY,
  RING_GAP,
  RING_DISPLAY_MIN_SIZE,
  clampRingPerRow,
  clampRingSize,
  effectiveRingSize,
  normalizeRingsState,
  providerLogoKey,
  ringAccountKey,
  ringAccountLabel,
  ringDashArray,
  ringItems,
  ringPercent,
  ringPercentText,
  ringShowPercent,
  ringTitle,
  ringTone,
  ringsPerRowInputSchema,
  ringsSizeInputSchema,
  ringsStateSchema,
  ringsToggleInputSchema,
} from "./rings";
import type { RelayAccount } from "./relay-accounts";

const account = (partial: Partial<RelayAccount> & { auth_index: string }): RelayAccount => ({
  disabled: false,
  quotas: [],
  ...partial,
});

describe("rings state", () => {
  it("uses the documented kv key", () => {
    expect(RINGS_KV_KEY).toBe("relay-rings");
  });

  it("clamps the size to 24..64 with 40 as the default", () => {
    expect(RING_SIZE_MIN).toBe(24);
    expect(RING_SIZE_MAX).toBe(64);
    expect(RING_SIZE_DEFAULT).toBe(40);
    expect(clampRingSize(undefined)).toBe(RING_SIZE_DEFAULT);
    expect(clampRingSize(Number.NaN)).toBe(RING_SIZE_DEFAULT);
    expect(clampRingSize("48")).toBe(RING_SIZE_DEFAULT);
    expect(clampRingSize(10)).toBe(24);
    expect(clampRingSize(100)).toBe(64);
    expect(clampRingSize(47.6)).toBe(48);
  });

  it("clamps the column count to 1..4 with 1 as the default", () => {
    expect(RING_PER_ROW_MIN).toBe(1);
    expect(RING_PER_ROW_MAX).toBe(4);
    expect(RING_PER_ROW_DEFAULT).toBe(1);
    expect(clampRingPerRow(undefined)).toBe(RING_PER_ROW_DEFAULT);
    expect(clampRingPerRow(Number.NaN)).toBe(RING_PER_ROW_DEFAULT);
    expect(clampRingPerRow("3")).toBe(RING_PER_ROW_DEFAULT);
    expect(clampRingPerRow(0)).toBe(1);
    expect(clampRingPerRow(9)).toBe(4);
    expect(clampRingPerRow(2.6)).toBe(3);
  });

  it("normalizes unknown kv contents to an empty selection", () => {
    expect(normalizeRingsState(undefined)).toEqual({ selected: [], size: 40, perRow: 1 });
    expect(normalizeRingsState(null)).toEqual({ selected: [], size: 40, perRow: 1 });
    expect(normalizeRingsState("oops")).toEqual({ selected: [], size: 40, perRow: 1 });
    expect(normalizeRingsState({ selected: "oops", size: 999, perRow: 99 })).toEqual({ selected: [], size: 64, perRow: 4 });
  });

  it("keeps a state saved before perRow existed on one column", () => {
    expect(normalizeRingsState({ selected: ["a|1"], size: 44 })).toEqual({ selected: ["a|1"], size: 44, perRow: 1 });
  });

  it("dedupes, trims and drops empty selected keys", () => {
    expect(
      normalizeRingsState({ selected: [" a|1 ", "a|1", "", "  ", 7, null, "b|2"], size: 30, perRow: 2 }),
    ).toEqual({ selected: ["a|1", "b|2"], size: 30, perRow: 2 });
  });

  it("keeps only string keys on a second normalize pass", () => {
    const once = normalizeRingsState({ selected: ["a|1", "a|1"], size: 32, perRow: 3 });
    expect(normalizeRingsState(once)).toEqual(once);
  });
});

describe("account keys", () => {
  it("builds a stable `${origin}|${auth_index}` key", () => {
    const item = account({ auth_index: "claude:u@example.com", auth_name: "claude-1.json" });
    expect(ringAccountKey("http://localhost:4010", item)).toBe(
      "http://localhost:4010|claude:u@example.com",
    );
    expect(ringAccountKey("http://localhost:4010", { auth_index: "claude:u@example.com" })).toBe(
      ringAccountKey("http://localhost:4010", item),
    );
  });

  it("keeps accounts of different origins apart", () => {
    const item = account({ auth_index: "k1" });
    expect(ringAccountKey("http://a:1", item)).not.toBe(ringAccountKey("http://b:1", item));
  });

  it("labels an account like the account card does", () => {
    expect(ringAccountLabel({ auth_index: "k1", email: "u@example.com", provider: "kimi", label: "kimi" })).toBe("u@example.com");
    expect(ringAccountLabel({ auth_index: "k1", provider: "kimi", label: "kimi-2" })).toBe("kimi-2");
    expect(ringAccountLabel({ auth_index: "k1", provider: "kimi", label: "kimi" })).toBe("k1");
    expect(ringAccountLabel({ auth_index: "k1" })).toBe("k1");
  });
});

describe("percent and tone", () => {
  it("takes the first quota with a percent, rounded and clamped", () => {
    expect(ringPercent([])).toBeNull();
    expect(ringPercent([{ quota_key: "a", percent: null }])).toBeNull();
    expect(ringPercent([{ quota_key: "a", percent: null }, { quota_key: "b", percent: 42.4 }])).toBe(42);
    expect(ringPercent([{ quota_key: "a", percent: 133 }])).toBe(100);
    expect(ringPercent([{ quota_key: "a", percent: -4 }])).toBe(0);
    expect(ringPercent([{ quota_key: "a" }])).toBeNull();
  });

  it("maps percent to the usage-rings tones", () => {
    expect(ringTone(null)).toBe("unknown");
    expect(ringTone(5)).toBe("critical");
    expect(ringTone(6)).toBe("warning");
    expect(ringTone(20)).toBe("warning");
    expect(ringTone(21)).toBe("normal");
  });

  it("writes the usage-rings dasharray", () => {
    expect(ringDashArray(0)).toBe("0 100");
    expect(ringDashArray(42)).toBe("42 100");
  });

  it("names the ring for assistive tech", () => {
    expect(ringTitle("kimi", 42)).toBe("kimi: осталось 42%");
    expect(ringTitle("kimi", null)).toBe("kimi: квота недоступна");
  });

  it("keeps the printed percent to four characters at most", () => {
    expect(ringPercentText(41)).toBe("41%");
    expect(ringPercentText(100)).toBe("100%");
    expect(ringPercentText(0)).toBe("0%");
    expect(ringPercentText(null)).toBe("—");
    for (const percent of [null, 0, 7, 41, 100]) {
      expect(ringPercentText(percent).length).toBeLessThanOrEqual(4);
    }
  });

  it("hides the printed percent below a 32px ring but keeps the label", () => {
    expect(ringShowPercent(RING_SIZE_MIN)).toBe(false);
    expect(ringShowPercent(31)).toBe(false);
    expect(ringShowPercent(32)).toBe(true);
    expect(ringShowPercent(RING_SIZE_DEFAULT)).toBe(true);
    expect(ringTitle("kimi", 41)).toContain("41%");
  });
});

describe("effective ring size", () => {
  it("uses the very gap the grid draws", () => {
    expect(RING_GAP).toBe(4);
    expect(RING_DISPLAY_MIN_SIZE).toBe(12);
  });

  it("keeps the setting in one column", () => {
    expect(effectiveRingSize(40, 1, 40)).toBe(40);
    expect(effectiveRingSize(40, 1, 64)).toBe(40);
    expect(effectiveRingSize(120, 1, 40)).toBe(40);
  });

  it("shrinks two columns into a narrow 40px rail", () => {
    // (40 - 4) / 2 = 18
    expect(effectiveRingSize(40, 2, 40)).toBe(18);
    expect(effectiveRingSize(40, 3, 40)).toBe(12);
    expect(effectiveRingSize(40, 4, 40)).toBe(12);
  });

  it("never grows past the setting, so a wide rail changes nothing", () => {
    expect(effectiveRingSize(200, 2, 40)).toBe(40);
    expect(effectiveRingSize(200, 4, 24)).toBe(24);
    expect(effectiveRingSize(48, 2, 64)).toBe(22);
  });

  it("falls back to the setting until the rail is measured", () => {
    expect(effectiveRingSize(0, 2, 40)).toBe(40);
    expect(effectiveRingSize(-10, 3, 48)).toBe(48);
    expect(effectiveRingSize(Number.NaN, 2, 40)).toBe(40);
    expect(effectiveRingSize(Number.POSITIVE_INFINITY, 2, 40)).toBe(40);
  });

  it("clamps what it returns to a drawable range", () => {
    expect(effectiveRingSize(40, 2, 4)).toBe(12);
    expect(effectiveRingSize(1_000, 1, 999)).toBe(64);
  });

  it("honours a custom gap", () => {
    expect(effectiveRingSize(40, 2, 40, 8)).toBe(16);
    expect(effectiveRingSize(40, 1, 40, 8)).toBe(40);
  });
});

describe("provider logos", () => {
  it("maps provider ids to the vendored artwork", () => {
    expect(providerLogoKey("kimi")).toBe("kimi");
    expect(providerLogoKey("Kimi K2")).toBe("kimi");
    expect(providerLogoKey("moonshot")).toBe("kimi");
    expect(providerLogoKey("claude")).toBe("claude");
    expect(providerLogoKey("Anthropic")).toBe("claude");
    expect(providerLogoKey("grok")).toBe("grok");
    expect(providerLogoKey("xAI")).toBe("grok");
    expect(providerLogoKey("gpt")).toBe("gpt");
    expect(providerLogoKey("openai")).toBe("gpt");
    expect(providerLogoKey("GPT-5 Codex")).toBe("gpt");
    expect(providerLogoKey("ChatGPT")).toBe("gpt");
  });

  it("falls back to no artwork for unknown providers", () => {
    expect(providerLogoKey("gemini")).toBeNull();
    expect(providerLogoKey()).toBeNull();
    expect(providerLogoKey(undefined, null, "  ")).toBeNull();
  });
});

describe("ring items", () => {
  const kimi = account({
    auth_index: "kimi:1",
    provider: "kimi",
    email: "k@example.com",
    quotas: [{ quota_key: "m_quota.code_5h", percent: 63 }],
  });
  const claude = account({
    auth_index: "claude:1",
    provider: "claude",
    quotas: [{ quota_key: "5h", percent: null }],
  });

  it("keeps one ring per provider type in selection order", () => {
    const items = ringItems(["http://a:1|claude:1", "http://a:1|kimi:1"], [
      { origin: "http://a:1", accounts: [kimi, claude] },
    ]);
    expect(items.map((item) => item.key)).toEqual(["claude", "kimi"]);
    expect(items[0]).toMatchObject({ label: "Claude", percent: null, tone: "unknown", activeCount: 1 });
    expect(items[1]).toMatchObject({ label: "Kimi", percent: 63, tone: "normal", activeCount: 1 });
  });

  it("draws a single account of a type like before", () => {
    const [item] = ringItems(["http://a:1|kimi:1"], [{ origin: "http://a:1", accounts: [kimi] }]);
    expect(item).toMatchObject({ key: "kimi", label: "Kimi", logo: "kimi", percent: 63, tone: "normal" });
    expect(item!.accounts).toHaveLength(1);
    expect(item!.accounts[0]).toMatchObject({ key: "http://a:1|kimi:1", label: "k@example.com", percent: 63, disabled: false });
    expect(ringTitle(item!.label, item!.percent, item!.activeCount)).toBe("Kimi: осталось 63%");
  });

  it("drops selected keys that no origin resolved", () => {
    const items = ringItems(["http://a:1|gone", "http://a:1|kimi:1"], [
      { origin: "http://a:1", accounts: [kimi] },
    ]);
    expect(items.map((item) => item.key)).toEqual(["kimi"]);
  });

  it("folds two accounts of one type into the biggest active remainder", () => {
    const small = account({ auth_index: "kimi:2", provider: "kimi", label: "kimi-2", quotas: [{ quota_key: "5h", percent: 31 }] });
    const items = ringItems(["http://a:1|kimi:1", "http://a:1|kimi:2"], [
      { origin: "http://a:1", accounts: [kimi, small] },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: "kimi", percent: 63, activeCount: 2 });
    expect(ringTitle(items[0]!.label, items[0]!.percent, items[0]!.activeCount))
      .toBe("Kimi: осталось 63% (больший активный из 2)");
  });

  it("leaves a disabled account out of the maximum", () => {
    const off = account({ auth_index: "kimi:3", provider: "kimi", disabled: true, quotas: [{ quota_key: "5h", percent: 90 }] });
    const [item] = ringItems(["http://a:1|kimi:1", "http://a:1|kimi:3"], [
      { origin: "http://a:1", accounts: [kimi, off] },
    ]);
    expect(item).toMatchObject({ percent: 63, activeCount: 1, tone: "normal" });
  });

  it("shows a dash when every account of the type is disabled", () => {
    const offA = account({ auth_index: "kimi:4", provider: "kimi", disabled: true, quotas: [{ quota_key: "5h", percent: 90 }] });
    const offB = account({ auth_index: "kimi:5", provider: "kimi", disabled: true, quotas: [{ quota_key: "5h", percent: 12 }] });
    const [item] = ringItems(["http://a:1|kimi:4", "http://a:1|kimi:5"], [
      { origin: "http://a:1", accounts: [offA, offB] },
    ]);
    expect(item).toMatchObject({ percent: null, tone: "unknown", activeCount: 0 });
    expect(ringTitle(item!.label, item!.percent, item!.activeCount)).toBe("Kimi: квота недоступна");
  });

  it("skips accounts whose quota has no percent when taking the maximum", () => {
    const unknownPercent = account({ auth_index: "kimi:6", provider: "kimi", quotas: [{ quota_key: "5h", percent: null }] });
    const [item] = ringItems(["http://a:1|kimi:6", "http://a:1|kimi:1"], [
      { origin: "http://a:1", accounts: [unknownPercent, kimi] },
    ]);
    expect(item!.percent).toBe(63);
    expect(item!.activeCount).toBe(2);
  });

  it("orders the popover accounts: active first, then by remainder", () => {
    const low = account({ auth_index: "kimi:7", provider: "kimi", label: "low", quotas: [{ quota_key: "5h", percent: 12 }] });
    const off = account({ auth_index: "kimi:8", provider: "kimi", label: "off", disabled: true, quotas: [{ quota_key: "5h", percent: 99 }] });
    const [item] = ringItems(
      ["http://a:1|kimi:8", "http://a:1|kimi:7", "http://a:1|kimi:1"],
      [{ origin: "http://a:1", accounts: [off, low, kimi] }],
    );
    expect(item!.accounts.map((entry) => entry.key)).toEqual([
      "http://a:1|kimi:1",
      "http://a:1|kimi:7",
      "http://a:1|kimi:8",
    ]);
    expect(item!.accounts.map((entry) => entry.disabled)).toEqual([false, false, true]);
    expect(item!.accounts[2]).toMatchObject({ label: "off", percent: 99 });
  });

  it("keeps artwork and per-account quotas for the popover", () => {
    const [item] = ringItems(["http://a:1|kimi:1"], [{ origin: "http://a:1", accounts: [kimi] }]);
    expect(item!.logo).toBe("kimi");
    expect(item!.accounts[0]!.quotas).toHaveLength(1);
    expect(item!.provider).toBe("kimi");
  });

  it("names an unknown provider type by its id and keeps it apart", () => {
    const codexA = account({ auth_index: "codex:1", provider: "codex", quotas: [{ quota_key: "5h", percent: 40 }] });
    const codexB = account({ auth_index: "codex:2", provider: "codex", quotas: [{ quota_key: "5h", percent: 70 }] });
    const items = ringItems(["http://a:1|codex:1", "http://a:1|codex:2", "http://a:1|kimi:1"], [
      { origin: "http://a:1", accounts: [codexA, codexB, kimi] },
    ]);
    expect(items.map((item) => item.key)).toEqual(["codex", "kimi"]);
    expect(items[0]).toMatchObject({ label: "Codex", logo: null, percent: 70, activeCount: 2 });
  });

  it("folds the same type from two relay origins into one ring", () => {
    const other = account({ auth_index: "kimi:9", provider: "kimi", quotas: [{ quota_key: "5h", percent: 88 }] });
    const [item] = ringItems(["http://a:1|kimi:1", "http://b:1|kimi:9"], [
      { origin: "http://a:1", accounts: [kimi] },
      { origin: "http://b:1", accounts: [other] },
    ]);
    expect(item).toMatchObject({ key: "kimi", percent: 88, activeCount: 2 });
    // активные первыми, внутри — по убыванию остатка: 88 раньше 63
    expect(item!.accounts.map((entry) => entry.key)).toEqual(["http://b:1|kimi:9", "http://a:1|kimi:1"]);
  });
});

describe("rpc schemas", () => {
  it("accepts a normalized state and rejects undefined", () => {
    expect(ringsStateSchema.parse({ selected: ["a|1"], size: 40, perRow: 2 })).toEqual({ selected: ["a|1"], size: 40, perRow: 2 });
    expect(() => ringsStateSchema.parse({ selected: ["a|1"] })).toThrow();
  });

  it("validates the per-row input", () => {
    expect(ringsPerRowInputSchema.parse({ perRow: 3 })).toEqual({ perRow: 3 });
    expect(() => ringsPerRowInputSchema.parse({ perRow: Number.NaN })).toThrow();
    expect(() => ringsPerRowInputSchema.parse({ perRow: "3" })).toThrow();
    expect(() => ringsPerRowInputSchema.parse({ perRow: 3, extra: 1 })).toThrow();
  });

  it("validates toggle input", () => {
    expect(ringsToggleInputSchema.parse({ key: "a|1", on: true })).toEqual({ key: "a|1", on: true });
    expect(() => ringsToggleInputSchema.parse({ key: "", on: true })).toThrow();
    expect(() => ringsToggleInputSchema.parse({ key: "a|1" })).toThrow();
    expect(() => ringsToggleInputSchema.parse({ key: "a|1", on: true, extra: 1 })).toThrow();
  });

  it("validates size input", () => {
    expect(ringsSizeInputSchema.parse({ size: 48 })).toEqual({ size: 48 });
    expect(() => ringsSizeInputSchema.parse({ size: Number.POSITIVE_INFINITY })).toThrow();
    expect(() => ringsSizeInputSchema.parse({ size: "48" })).toThrow();
  });
});
