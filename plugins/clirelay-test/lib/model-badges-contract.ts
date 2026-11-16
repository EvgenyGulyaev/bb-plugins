// Общий контракт значков моделей: сервер регистрирует его вместе с остальными
// методами, фронтенд берёт схемы для keyed-запроса (нужен runtime-объект).
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { FAMILY_IDS } from "./model-families";

export const familySchema = z.enum(FAMILY_IDS);

export const familyMarkSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("icon"), value: z.string().min(1).max(64) }).strict(),
  z.object({ kind: z.literal("text"), value: z.string().min(1).max(16) }).strict(),
  z.object({ kind: z.literal("svg"), value: z.string().min(1).max(8000) }).strict(),
]);

export const threadModelSchema = z.object({
  providerId: z.string(),
  model: z.string(),
  updatedAt: z.number(),
});

export const threadBadgeSchema = z
  .object({
    providerId: z.string(),
    model: z.string(),
    family: familySchema,
    mark: familyMarkSchema,
  })
  .nullable();

export const modelBadgesContract = defineRpcContract({
  model_badges_state: {
    input: z.null(),
    output: z.object({
      threads: z.record(z.string(), threadModelSchema),
      marks: z.record(familySchema, familyMarkSchema),
    }),
  },
  model_badges_for: {
    input: z.object({ keys: z.array(z.string().min(1)).max(200) }).strict(),
    output: z.record(z.string(), threadBadgeSchema),
  },
  model_badges_marks_set: {
    input: z.object({ family: familySchema, mark: familyMarkSchema }).strict(),
    output: z.object({ marks: z.record(familySchema, familyMarkSchema) }),
  },
});
