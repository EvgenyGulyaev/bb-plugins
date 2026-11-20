import { describe, expect, it } from "vitest";
import { createLatestMessageStore } from "./latest-message";

describe("latest message election", () => {
  it("один бейдж: выигрывает максимум createdAt внутри turnId", () => {
    const store = createLatestMessageStore();
    store.register({ threadId: "thr_1", turnId: "turn-1", messageId: "m1", createdAt: 10 });
    expect(store.isLatest("thr_1:turn-1", "m1")).toBe(true);
    store.register({ threadId: "thr_1", turnId: "turn-1", messageId: "m2", createdAt: 20 });
    expect(store.isLatest("thr_1:turn-1", "m1")).toBe(false);
    expect(store.isLatest("thr_1:turn-1", "m2")).toBe(true);
  });

  it("unmount раннего не меняет выбор; повторный mount того же id считается по ссылкам", () => {
    const store = createLatestMessageStore();
    const first = { threadId: "thr_1", turnId: "turn-1", messageId: "m1", createdAt: 10 };
    const dispose1 = store.register(first);
    const dispose2 = store.register(first);
    dispose1();
    expect(store.isLatest("thr_1:turn-1", "m1")).toBe(true);
    dispose2();
    expect(store.isLatest("thr_1:turn-1", "m1")).toBe(false);
  });
});
