import { describe, expect, it } from "vitest";
import { forgetThread, mergeResolved, recordModel, threadBadge, type ThreadModels } from "./model-badges";
import { resolveMarks } from "./model-marks";

const marks = resolveMarks({});

describe("recordModel", () => {
  it("добавляет и обновляет запись при смене модели", () => {
    const empty: ThreadModels = {};
    const first = recordModel(empty, "t1", "pi", "gpt-6.1-sol", 1000);
    expect(first.t1).toEqual({ providerId: "pi", model: "gpt-6.1-sol", updatedAt: 1000 });
    expect(empty).toEqual({});
    const changed = recordModel(first, "t1", "pi", "claude-sonnet-5-5", 2000);
    expect(changed.t1).toMatchObject({ model: "claude-sonnet-5-5", updatedAt: 2000 });
  });

  it("неизменившееся значение не плодит новый map", () => {
    const first = recordModel({}, "t1", "pi", "gpt-6.1-sol", 1000);
    expect(recordModel(first, "t1", "pi", "gpt-6.1-sol", 2000)).toBe(first);
  });
});

describe("forgetThread", () => {
  it("удаляет запись; отсутствующую не трогает", () => {
    const first = recordModel({}, "t1", "pi", "gpt-x", 1000);
    expect(forgetThread(first, "t1")).toEqual({});
    expect(forgetThread(first, "t2")).toBe(first);
  });
});

describe("mergeResolved", () => {
  it("добавляет новые и обновляет устаревшие записи", () => {
    const current = recordModel({}, "t1", "pi", "gpt-old", 1000);
    const merged = mergeResolved(current, {
      t1: { providerId: "pi", model: "claude-new", updatedAt: 2000 },
      t2: { providerId: "pi", model: "grok-4.7", updatedAt: 1500 },
    });
    expect(merged.t1).toMatchObject({ model: "claude-new", updatedAt: 2000 });
    expect(merged.t2).toMatchObject({ model: "grok-4.7" });
  });

  it("не затирает более свежую запись из hook", () => {
    const current = recordModel({}, "t1", "pi", "claude-from-hook", 3000);
    const merged = mergeResolved(current, {
      t1: { providerId: "pi", model: "gpt-stale", updatedAt: 2000 },
    });
    expect(merged).toBe(current);
    expect(merged.t1!.model).toBe("claude-from-hook");
  });
});

describe("threadBadge", () => {
  it("отдаёт марку семейства для pi-треда", () => {
    const threads = recordModel({}, "t1", "pi", "claude-sonnet-5-5", 1000);
    expect(threadBadge(threads, marks, "t1")).toEqual({
      providerId: "pi",
      model: "claude-sonnet-5-5",
      family: "claude",
      mark: marks.claude,
    });
  });

  it("null для не-pi, неизвестного и пустой модели", () => {
    const threads = recordModel({}, "t1", "claude-code", "claude-x", 1000);
    expect(threadBadge(threads, marks, "t1")).toBeNull();
    expect(threadBadge(threads, marks, "missing")).toBeNull();
    expect(threadBadge(recordModel({}, "t2", "pi", "", 1000), marks, "t2")).toBeNull();
  });
});
