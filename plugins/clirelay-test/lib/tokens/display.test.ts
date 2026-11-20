import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOKENS_DISPLAY,
  applyTokensDisplayPatch,
  normalizeTokensDisplay,
  tokensDisplayPatchSchema,
  tokensDisplaySchema,
} from "./display";

describe("normalizeTokensDisplay", () => {
  it.each([undefined, null, 42, "x", []])("мусор %s → дефолт новой копией", (raw) => {
    const result = normalizeTokensDisplay(raw);
    expect(result).toEqual(DEFAULT_TOKENS_DISPLAY);
    // Копия, а не ссылка: мутация результата не портит дефолт.
    result.badge.fields.model = true;
    expect(DEFAULT_TOKENS_DISPLAY.badge.fields.model).toBe(false);
  });

  it("частичный объект: булевы значения берём, не-булевы — дефолт, лишние ключи отбрасываем", () => {
    const result = normalizeTokensDisplay({
      badge: { enabled: false, fields: { model: "yes", reasoning: true, extra: 1 } },
    });
    expect(result.badge.enabled).toBe(false);
    expect(result.badge.fields.reasoning).toBe(true);
    expect(result.badge.fields.model).toBe(false);
    expect(result.badge.fields).not.toHaveProperty("extra");
    expect(result.thread).toEqual(DEFAULT_TOKENS_DISPLAY.thread);
    expect(() => tokensDisplaySchema.parse(result)).not.toThrow();
  });

  it("дефолты закреплены: текущий вид token-meter, новые поля выключены", () => {
    expect(DEFAULT_TOKENS_DISPLAY.thread.enabled).toBe(true);
    expect(DEFAULT_TOKENS_DISPLAY.thread.fields).toEqual({
      total: true, speed: true, model: false, turns: false, contextWindow: false,
    });
    expect(DEFAULT_TOKENS_DISPLAY.badge.enabled).toBe(true);
    expect(DEFAULT_TOKENS_DISPLAY.badge.fields).toEqual({
      input: true, output: true, cache: true, reasoning: false, speed: true, model: false,
    });
  });
});

describe("applyTokensDisplayPatch", () => {
  it("меняет тумблер секции и отдельное поле, вход не мутирует", () => {
    const before = normalizeTokensDisplay(undefined);
    const snapshot = structuredClone(before);

    const badgeOff = applyTokensDisplayPatch(before, { target: "badge", enabled: false });
    expect(badgeOff.badge.enabled).toBe(false);
    expect(badgeOff.thread).toEqual(before.thread);

    const threadOff = applyTokensDisplayPatch(before, { target: "thread", enabled: false });
    expect(threadOff.thread.enabled).toBe(false);

    const threadField = applyTokensDisplayPatch(before, { target: "threadField", field: "turns", on: true });
    expect(threadField.thread.fields.turns).toBe(true);

    const badgeField = applyTokensDisplayPatch(before, { target: "badgeField", field: "reasoning", on: true });
    expect(badgeField.badge.fields.reasoning).toBe(true);
    expect(badgeField.badge.fields.input).toBe(true);

    expect(before).toEqual(snapshot);
    expect(badgeOff).not.toBe(before);
    expect(badgeOff.badge).not.toBe(before.badge);
  });

  it("выключить можно все поля сразу — отдельного правила нет", () => {
    let state = normalizeTokensDisplay(undefined);
    for (const field of ["input", "output", "cache", "speed"] as const) {
      state = applyTokensDisplayPatch(state, { target: "badgeField", field, on: false });
    }
    expect(Object.values(state.badge.fields).every((on) => on === false)).toBe(true);
  });
});

describe("tokensDisplayPatchSchema", () => {
  it("отклоняет поле чужой секции и лишний ключ", () => {
    expect(tokensDisplayPatchSchema.safeParse({ target: "badgeField", field: "total", on: true }).success).toBe(false);
    expect(tokensDisplayPatchSchema.safeParse({ target: "threadField", field: "reasoning", on: true }).success).toBe(false);
    expect(tokensDisplayPatchSchema.safeParse({ target: "badge", enabled: true, on: true }).success).toBe(false);
    expect(tokensDisplayPatchSchema.safeParse({ target: "badge", enabled: true }).success).toBe(true);
  });
});