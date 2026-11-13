import { describe, expect, it } from "vitest";
import { MODEL_FIELDS, modelPatchSchema, providerIdSchema } from "./schema";

describe("modelPatchSchema", () => {
  it("принимает типы полей и null-удаление", () => {
    const patch = { reasoning: true, contextWindow: 400000, input: ["text", "image"], name: null };
    expect(modelPatchSchema.parse(patch)).toEqual(patch);
  });
  it("отклоняет неверные типы, пустой input, неизвестные поля", () => {
    expect(modelPatchSchema.safeParse({ contextWindow: "много" }).success).toBe(false);
    expect(modelPatchSchema.safeParse({ reasoning: 1 }).success).toBe(false);
    expect(modelPatchSchema.safeParse({ input: [] }).success).toBe(false);
    expect(modelPatchSchema.safeParse({ compat: {} }).success).toBe(false);
  });
  it("форма покрывает все поля патча", () => {
    expect(MODEL_FIELDS.map((f) => f.key).sort()).toEqual(["contextWindow", "input", "maxTokens", "name", "reasoning"]);
  });
});

describe("providerIdSchema", () => {
  it("только slug", () => {
    expect(providerIdSchema.safeParse("router-gpt").success).toBe(true);
    expect(providerIdSchema.safeParse("Router GPT").success).toBe(false);
    expect(providerIdSchema.safeParse("").success).toBe(false);
  });
});
