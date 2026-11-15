import { describe, expect, it } from "vitest";

import { groupBoardThreads, type BoardThreadRef } from "./board-tree";

function thread(
  id: string,
  partial: Partial<BoardThreadRef> = {},
): BoardThreadRef {
  return {
    id,
    parentThreadId: null,
    createdAt: 0,
    ...partial,
  };
}

describe("groupBoardThreads", () => {
  it("returns every thread as a card when none has a parent", () => {
    const cards = groupBoardThreads([thread("a"), thread("b")]);
    expect(cards.map((card) => card.thread.id)).toEqual(["a", "b"]);
    expect(cards.every((card) => card.children.length === 0)).toBe(true);
  });

  it("nests a child under its parent and keeps the parent card", () => {
    const cards = groupBoardThreads([
      thread("parent"),
      thread("child", { parentThreadId: "parent" }),
    ]);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.thread.id).toBe("parent");
    expect(cards[0]!.children.map((child) => child.id)).toEqual(["child"]);
  });

  it("flattens grandchildren under the top-level card", () => {
    const cards = groupBoardThreads([
      thread("root"),
      thread("child", { parentThreadId: "root" }),
      thread("grandchild", { parentThreadId: "child" }),
    ]);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.children.map((entry) => entry.id)).toEqual([
      "child",
      "grandchild",
    ]);
  });

  it("orders children by createdAt and breaks ties by id", () => {
    const cards = groupBoardThreads([
      thread("root"),
      thread("late", { parentThreadId: "root", createdAt: 30 }),
      thread("early-b", { parentThreadId: "root", createdAt: 10 }),
      thread("early-a", { parentThreadId: "root", createdAt: 10 }),
    ]);
    expect(cards[0]!.children.map((entry) => entry.id)).toEqual([
      "early-a",
      "early-b",
      "late",
    ]);
  });

  it("keeps the incoming order of top-level cards", () => {
    const cards = groupBoardThreads([
      thread("second"),
      thread("child", { parentThreadId: "first" }),
      thread("first"),
    ]);
    expect(cards.map((card) => card.thread.id)).toEqual(["second", "first"]);
    expect(cards[1]!.children.map((child) => child.id)).toEqual(["child"]);
  });

  it("draws a thread whose parent is off the board as its own card", () => {
    const cards = groupBoardThreads([
      thread("orphan", { parentThreadId: "archived" }),
    ]);
    expect(cards.map((card) => card.thread.id)).toEqual(["orphan"]);
    expect(cards[0]!.children).toEqual([]);
  });

  it("does not lose threads caught in a parent cycle", () => {
    const cards = groupBoardThreads([
      thread("a", { parentThreadId: "b" }),
      thread("b", { parentThreadId: "a" }),
    ]);
    expect(cards.map((card) => card.thread.id).sort()).toEqual(["a", "b"]);
    expect(cards.every((card) => card.children.length === 0)).toBe(true);
  });

  it("returns no cards for no threads", () => {
    expect(groupBoardThreads([])).toEqual([]);
  });
});
