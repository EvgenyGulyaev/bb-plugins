import { describe, expect, it } from "vitest";
import { FAMILY_IDS } from "./model-families";
import { DEFAULT_MARKS, markFor, normalizeMark, resolveMarks } from "./model-marks";

const SAFE_SVG = '<svg viewBox="0 0 16 16"><path d="M0 0h16v16H0z"/></svg>';

describe("DEFAULT_MARKS", () => {
  it("у крупных семейств разные иконки, у х5 — текст", () => {
    const named = ["gpt", "claude", "deepseek", "grok", "gemini", "qwen", "kimi"] as const;
    const icons = named.map((family) => DEFAULT_MARKS[family]);
    expect(new Set(icons.map((mark) => mark.value)).size).toBe(named.length);
    expect(icons.every((mark) => mark.kind === "icon")).toBe(true);
    expect(DEFAULT_MARKS.x5).toEqual({ kind: "text", value: "х5" });
  });

  it("покрывает все семейства", () => {
    for (const family of FAMILY_IDS) expect(DEFAULT_MARKS[family]).toBeDefined();
  });
});

describe("normalizeMark", () => {
  it("принимает иконку, текст и безопасный SVG", () => {
    expect(normalizeMark({ kind: "icon", value: "  Sparkles " })).toEqual({ kind: "icon", value: "Sparkles" });
    expect(normalizeMark({ kind: "text", value: " х5 " })).toEqual({ kind: "text", value: "х5" });
    expect(normalizeMark({ kind: "svg", value: SAFE_SVG })).toEqual({ kind: "svg", value: SAFE_SVG });
  });

  it("отклоняет пустое, длинное и небезопасное", () => {
    expect(normalizeMark({ kind: "icon", value: "" })).toBeNull();
    expect(normalizeMark({ kind: "icon", value: "x".repeat(65) })).toBeNull();
    expect(normalizeMark({ kind: "text", value: "х".repeat(17) })).toBeNull();
    expect(normalizeMark({ kind: "svg", value: "<svg><script>alert(1)</script></svg>" })).toBeNull();
    expect(normalizeMark({ kind: "svg", value: '<svg><foreignObject/></svg>' })).toBeNull();
    expect(normalizeMark({ kind: "svg", value: '<svg><a href="https://example.com/x">x</a></svg>' })).toBeNull();
    expect(normalizeMark({ kind: "nope", value: "x" })).toBeNull();
    expect(normalizeMark(null)).toBeNull();
  });
});

describe("resolveMarks", () => {
  it("без сохранённых — дефолты", () => {
    expect(resolveMarks(null)).toEqual(DEFAULT_MARKS);
  });

  it("валидные сохранённые перекрывают дефолты, мусор игнорируется", () => {
    const marks = resolveMarks({
      gpt: { kind: "text", value: "G" },
      claude: { kind: "svg", value: "<svg><script>x</script></svg>" },
      hacked: { kind: "icon", value: "Evil" },
    });
    expect(marks.gpt).toEqual({ kind: "text", value: "G" });
    expect(marks.claude).toEqual(DEFAULT_MARKS.claude);
    expect(marks).not.toHaveProperty("hacked");
  });

  it("markFor отдаёт сохранённую или дефолтную марку", () => {
    const marks = resolveMarks({ gemini: { kind: "text", value: "Gm" } });
    expect(markFor(marks, "gemini")).toEqual({ kind: "text", value: "Gm" });
    expect(markFor(marks, "mistral")).toEqual(DEFAULT_MARKS.mistral);
  });
});
