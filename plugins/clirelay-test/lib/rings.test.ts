import { describe, expect, it } from "vitest";
import {
  RING_PER_ROW_DEFAULT,
  RING_PER_ROW_MAX,
  RING_PER_ROW_MIN,
  RING_SIZE_DEFAULT,
  RING_SIZE_MAX,
  RING_SIZE_MIN,
  RINGS_KV_KEY,
  clampRingPerRow,
  clampRingSize,
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

  it("returns selected accounts in selection order", () => {
    const items = ringItems(["http://a:1|claude:1", "http://a:1|kimi:1"], [
      { origin: "http://a:1", accounts: [kimi, claude] },
    ]);
    expect(items.map((item) => item.key)).toEqual(["http://a:1|claude:1", "http://a:1|kimi:1"]);
    expect(items[0]).toMatchObject({ label: "claude:1", percent: null, tone: "unknown" });
    expect(items[1]).toMatchObject({ label: "k@example.com", percent: 63, tone: "normal" });
  });

  it("drops selected keys that no origin resolved", () => {
    const items = ringItems(["http://a:1|gone", "http://a:1|kimi:1"], [
      { origin: "http://a:1", accounts: [kimi] },
    ]);
    expect(items.map((item) => item.key)).toEqual(["http://a:1|kimi:1"]);
  });

  it("keeps provider artwork and quotas for the popover", () => {
    const [item] = ringItems(["http://a:1|kimi:1"], [{ origin: "http://a:1", accounts: [kimi] }]);
    expect(item!.logo).toBe("kimi");
    expect(item!.quotas).toHaveLength(1);
    expect(item!.provider).toBe("kimi");
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
