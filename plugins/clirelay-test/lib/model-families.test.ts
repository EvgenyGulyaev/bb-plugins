import { describe, expect, it } from "vitest";
import { familiesOf, familyOf } from "./model-families";

describe("familyOf", () => {
  it("распознаёт семейства по нижнему регистру имени", () => {
    expect(familyOf("gpt-6.1-sol")).toBe("gpt");
    expect(familyOf("GPT-6 Astra")).toBe("gpt");
    expect(familyOf("claude-sonnet-5-5")).toBe("claude");
    expect(familyOf("deepseek-v4.1-flash")).toBe("deepseek");
    expect(familyOf("grok-4.7")).toBe("grok");
    expect(familyOf("gemini-3.8-flash")).toBe("gemini");
    expect(familyOf("qwen4-max")).toBe("qwen");
    expect(familyOf("kimi-k3.1-pro")).toBe("kimi");
    expect(familyOf("llama-4-scout")).toBe("llama");
    expect(familyOf("mistral-large")).toBe("mistral");
  });

  it("распознаёт подстроки, а не только префикс", () => {
    expect(familyOf("router/gpt-6.1")).toBe("gpt");
    expect(familyOf("openai-codex-mini")).toBe("gpt");
    expect(familyOf("anthropic/claude-sonnet")).toBe("claude");
    expect(familyOf("vendor/deepseek-v4")).toBe("deepseek");
    expect(familyOf("proxy/kimi-k3")).toBe("kimi");
    expect(familyOf("proxy/moonshot-v1")).toBe("kimi");
  });

  it("x5-префиксы → х5", () => {
    expect(familyOf("x5-airun-large")).toBe("x5");
    expect(familyOf("copilot-x5")).toBe("x5");
    expect(familyOf("X5-Airun-Small")).toBe("x5");
    expect(familyOf("copilot-code-large")).toBe("x5");
  });

  it("неизвестное → unknown", () => {
    expect(familyOf("some-unknown-model")).toBe("unknown");
    expect(familyOf("")).toBe("unknown");
  });

  it("familiesOf уникализирует в каноническом порядке", () => {
    expect(familiesOf(["claude-a", "gpt-b", "claude-c", "x5-airun"])).toEqual([
      "gpt",
      "claude",
      "x5",
    ]);
    expect(familiesOf([])).toEqual([]);
  });
});
