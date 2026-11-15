import { describe, expect, it } from "vitest";

import {
  EMPTY_RAIL_STATE,
  addItemToFolder,
  applyVisibleOrder,
  createFolder,
  deleteFolder,
  folderById,
  folderMembers,
  folderOfItem,
  layoutRail,
  moveFolder,
  moveFolderToIndex,
  normalizeState,
  orderedFolders,
  placeInOrder,
  railFoldersStateSchema,
  railSequence,
  removeItemFromFolder,
  renameFolder,
  reorderItems,
  setFolderIcon,
  setRailOrder,
} from "./folders";

const STATE = () =>
  createFolder(
    createFolder(EMPTY_RAIL_STATE, {
      id: "folder_a",
      name: "Работа",
      icon: "Briefcase",
      itemIds: ["plugin-a/new-thread"],
    }),
    { id: "folder_b", name: "Инструменты", icon: "Wrench" },
  );

const ITEMS = [
  { id: "__bb__/new-thread", isVisible: true },
  { id: "plugin-a/panel", isVisible: true },
  { id: "plugin-a/hidden", isVisible: false },
  { id: "plugin-b/tools", isVisible: true },
];

describe("normalizeState", () => {
  it("returns an empty state for null, arrays and primitives", () => {
    for (const value of [null, undefined, 42, "nope", [], {}]) {
      expect(normalizeState(value)).toEqual(EMPTY_RAIL_STATE);
    }
  });

  it("round-trips a valid state", () => {
    const state = STATE();
    expect(railFoldersStateSchema.parse(state)).toEqual(state);
    expect(normalizeState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it("drops only the invalid folders and keeps the rest", () => {
    const state = normalizeState({
      folders: [
        { id: "ok", name: "Хорошая", icon: "Folder", itemIds: ["a"] },
        { id: "", name: "Без id", icon: "Folder", itemIds: [] },
        { id: "blank", name: "   ", icon: "Folder", itemIds: [] },
        { id: "ok", name: "Дубль", icon: "Folder", itemIds: [] },
      ],
      order: ["ok", "ok", 7, "", "a"],
    });
    expect(state.folders.map((folder) => folder.id)).toEqual(["ok"]);
    expect(state.order).toEqual(["ok", "a"]);
  });

  it("keeps an item in the first folder that claims it", () => {
    const state = normalizeState({
      folders: [
        { id: "one", name: "One", icon: "Folder", itemIds: ["a", "b", "a"] },
        { id: "two", name: "Two", icon: "Folder", itemIds: ["b", "c"] },
      ],
      order: [],
    });
    expect(state.folders).toEqual([
      { id: "one", name: "One", icon: "Folder", itemIds: ["a", "b"] },
      { id: "two", name: "Two", icon: "Folder", itemIds: ["c"] },
    ]);
  });
});

describe("createFolder", () => {
  it("creates an empty folder and appends it to the order", () => {
    const state = createFolder(EMPTY_RAIL_STATE, {
      id: "folder_a",
      name: "  Работа  ",
      icon: " Briefcase ",
    });
    expect(state).toEqual({
      folders: [
        { id: "folder_a", name: "Работа", icon: "Briefcase", itemIds: [] },
      ],
      order: ["folder_a"],
    });
  });

  it("claims the given items and takes them from another folder", () => {
    const before = createFolder(EMPTY_RAIL_STATE, {
      id: "folder_a",
      name: "A",
      icon: "Folder",
      itemIds: ["one"],
    });
    const after = createFolder(before, {
      id: "folder_b",
      name: "B",
      icon: "Folder",
      itemIds: ["one", "two"],
    });
    expect(folderById(after, "folder_a")?.itemIds).toEqual([]);
    expect(folderById(after, "folder_b")?.itemIds).toEqual(["one", "two"]);
  });

  it("ignores duplicate ids, empty names and missing ids", () => {
    const state = STATE();
    expect(
      createFolder(state, { id: "folder_a", name: "Копия", icon: "Folder" }),
    ).toBe(state);
    expect(
      createFolder(state, { id: "folder_c", name: "   ", icon: "Folder" }),
    ).toBe(state);
    expect(
      createFolder(state, { id: "", name: "Пусто", icon: "Folder" }),
    ).toBe(state);
  });

  it("falls back to the default folder icon", () => {
    const state = createFolder(EMPTY_RAIL_STATE, {
      id: "folder_a",
      name: "A",
      icon: "   ",
    });
    expect(folderById(state, "folder_a")?.icon).toBe("Folder");
  });
});

describe("membership", () => {
  it("finds a folder by id and by member", () => {
    const state = STATE();
    expect(folderById(state, "folder_a")?.name).toBe("Работа");
    expect(folderById(state, "nope")).toBeNull();
    expect(folderOfItem(state, "plugin-a/new-thread")?.id).toBe("folder_a");
    expect(folderOfItem(state, "plugin-a/panel")).toBeNull();
  });

  it("adds an item once and moves it out of the previous folder", () => {
    const state = STATE();
    const added = addItemToFolder(state, "folder_b", "plugin-a/panel");
    expect(folderById(added, "folder_b")?.itemIds).toEqual(["plugin-a/panel"]);

    const again = addItemToFolder(added, "folder_b", "plugin-a/panel");
    expect(again).toBe(added);

    const moved = addItemToFolder(state, "folder_b", "plugin-a/new-thread");
    expect(folderById(moved, "folder_a")?.itemIds).toEqual([]);
    expect(folderById(moved, "folder_b")?.itemIds).toEqual([
      "plugin-a/new-thread",
    ]);
  });

  it("ignores an unknown folder and a blank item id", () => {
    const state = STATE();
    expect(addItemToFolder(state, "nope", "x")).toBe(state);
    expect(addItemToFolder(state, "folder_a", "  ")).toBe(state);
  });

  it("removes an item from whichever folder holds it, and is a no-op otherwise", () => {
    const state = STATE();
    const removed = removeItemFromFolder(state, "plugin-a/new-thread");
    expect(folderById(removed, "folder_a")?.itemIds).toEqual([]);
    expect(removeItemFromFolder(removed, "plugin-a/new-thread")).toBe(removed);
  });

  it("keeps only members that still exist when asked for known ids", () => {
    const state = addItemToFolder(STATE(), "folder_b", "gone/panel");
    const known = new Set(["plugin-a/new-thread", "plugin-b/tools"]);
    expect(folderMembers(folderById(state, "folder_b")!, known)).toEqual([]);
    expect(folderMembers(folderById(state, "folder_a")!, known)).toEqual([
      "plugin-a/new-thread",
    ]);
  });
});

describe("editing folders", () => {
  it("renames and re-icons a folder, trimming whitespace", () => {
    const renamed = renameFolder(STATE(), "folder_a", "  Дом  ");
    expect(folderById(renamed, "folder_a")?.name).toBe("Дом");
    const reiconed = setFolderIcon(renamed, "folder_a", " Home ");
    expect(folderById(reiconed, "folder_a")?.icon).toBe("Home");
  });

  it("ignores blank names, blank icons and unknown ids", () => {
    const state = STATE();
    expect(renameFolder(state, "folder_a", "   ")).toBe(state);
    expect(renameFolder(state, "nope", "X")).toBe(state);
    expect(setFolderIcon(state, "folder_a", "  ")).toBe(state);
    expect(setFolderIcon(state, "nope", "X")).toBe(state);
  });

  it("deletes a folder, ungroups its members and drops its order slot", () => {
    const state = deleteFolder(STATE(), "folder_a");
    expect(state.folders.map((folder) => folder.id)).toEqual(["folder_b"]);
    expect(state.order).toEqual(["folder_b"]);
    expect(folderOfItem(state, "plugin-a/new-thread")).toBeNull();
    expect(deleteFolder(state, "folder_a")).toBe(state);
  });

  it("moves a folder one slot through the mixed order, past icons and folders", () => {
    const state = {
      ...STATE(),
      order: ["__bb__/new-thread", "folder_a", "plugin-a/panel", "folder_b"],
    };
    expect(moveFolder(state, "folder_b", "up").order).toEqual([
      "__bb__/new-thread",
      "folder_a",
      "folder_b",
      "plugin-a/panel",
    ]);
    expect(moveFolder(state, "folder_a", "up").order).toEqual([
      "folder_a",
      "__bb__/new-thread",
      "plugin-a/panel",
      "folder_b",
    ]);
    expect(moveFolder(state, "folder_a", "down").order).toEqual([
      "__bb__/new-thread",
      "plugin-a/panel",
      "folder_a",
      "folder_b",
    ]);
    expect(moveFolder(state, "folder_b", "down")).toBe(state);
    expect(moveFolder(state, "folder_gone", "up")).toBe(state);
  });
});

describe("reordering folder members", () => {
  const members = () =>
    createFolder(EMPTY_RAIL_STATE, {
      id: "folder_a",
      name: "A",
      icon: "Folder",
      itemIds: ["one", "two", "three"],
    });

  it("replaces the member order without touching the rail order", () => {
    const state = members();
    const next = reorderItems(state, "folder_a", ["three", "one", "two"]);
    expect(folderById(next, "folder_a")?.itemIds).toEqual([
      "three",
      "one",
      "two",
    ]);
    expect(next.order).toEqual(state.order);
  });

  it("returns the same state when the order did not change", () => {
    const state = members();
    expect(reorderItems(state, "folder_a", ["one", "two", "three"])).toBe(
      state,
    );
  });

  it("rejects a lost, duplicated or foreign id", () => {
    const state = members();
    expect(() =>
      reorderItems(state, "folder_a", ["one", "two"]),
    ).toThrow(/permutation/);
    expect(() =>
      reorderItems(state, "folder_a", ["one", "two", "two"]),
    ).toThrow(/permutation/);
    expect(() =>
      reorderItems(state, "folder_a", ["one", "two", "four"]),
    ).toThrow(/permutation/);
    expect(() =>
      reorderItems(state, "folder_a", ["one", "two", "  "]),
    ).toThrow(/permutation/);
  });

  it("rejects an unknown folder", () => {
    expect(() => reorderItems(members(), "folder_gone", [])).toThrow(
      /folder_gone/,
    );
  });
});

describe("applyVisibleOrder", () => {
  it("reorders drawable members and leaves stale ids in their slots", () => {
    expect(
      applyVisibleOrder(
        ["one", "gone", "two"],
        ["one", "two"],
        ["two", "one"],
      ),
    ).toEqual(["two", "gone", "one"]);
  });
});

describe("moveFolderToIndex", () => {
  const state = () => ({
    ...STATE(),
    order: ["__bb__/new-thread", "folder_a", "plugin-a/panel", "folder_b"],
  });

  it("moves a folder to an absolute slot in the mixed order", () => {
    const before = state();
    const after = moveFolderToIndex(before, "folder_b", 0);
    expect(after.order).toEqual([
      "folder_b",
      "__bb__/new-thread",
      "folder_a",
      "plugin-a/panel",
    ]);
    expect(after.folders.map((folder) => folder.id)).toEqual([
      "folder_b",
      "folder_a",
    ]);
  });

  it("clamps an index below zero or past the end", () => {
    expect(moveFolderToIndex(state(), "folder_b", -5).order).toEqual([
      "folder_b",
      "__bb__/new-thread",
      "folder_a",
      "plugin-a/panel",
    ]);
    expect(moveFolderToIndex(state(), "folder_a", 99).order).toEqual([
      "__bb__/new-thread",
      "plugin-a/panel",
      "folder_b",
      "folder_a",
    ]);
  });

  it("pulls the last folder to the front for a negative index", () => {
    const four = ["a", "b", "c", "d"].reduce(
      (state, id) =>
        createFolder(state, { id: `folder_${id}`, name: id, icon: "Folder" }),
      EMPTY_RAIL_STATE,
    );
    expect(
      moveFolderToIndex(four, "folder_d", -1).order,
    ).toEqual(["folder_d", "folder_a", "folder_b", "folder_c"]);
  });

  it("is a no-op at the current position or for an unknown folder", () => {
    const before = state();
    expect(moveFolderToIndex(before, "folder_a", 1)).toBe(before);
    expect(moveFolderToIndex(before, "folder_b", 3)).toBe(before);
    expect(moveFolderToIndex(before, "folder_gone", 0)).toBe(before);
  });
});

describe("orderedFolders", () => {
  it("follows the saved order and appends folders it forgot", () => {
    const state = {
      ...STATE(),
      order: ["folder_b"],
    };
    expect(orderedFolders(state).map((folder) => folder.id)).toEqual([
      "folder_b",
      "folder_a",
    ]);
  });
});

describe("layoutRail", () => {
  it("places folders and single icons by the mixed order", () => {
    const state = {
      ...STATE(),
      order: ["plugin-b/tools", "folder_b", "plugin-a/panel"],
    };
    expect(layoutRail(state, ITEMS)).toEqual([
      { kind: "item", itemId: "plugin-b/tools" },
      { kind: "folder", folder: folderById(state, "folder_b") },
      { kind: "item", itemId: "plugin-a/panel" },
      { kind: "item", itemId: "__bb__/new-thread" },
      { kind: "folder", folder: folderById(state, "folder_a") },
    ]);
  });

  it("keeps an old folders-only order looking the same", () => {
    const state = STATE();
    expect(
      layoutRail(state, ITEMS).map((entry) =>
        entry.kind === "folder" ? entry.folder.id : entry.itemId,
      ),
    ).toEqual([
      "folder_a",
      "folder_b",
      "__bb__/new-thread",
      "plugin-a/panel",
      "plugin-b/tools",
    ]);
  });

  it("never draws a grouped, hidden or unknown item twice", () => {
    const state = {
      ...STATE(),
      order: ["folder_a", "plugin-a/hidden", "gone/panel", "plugin-a/panel"],
    };
    const layout = layoutRail(state, ITEMS);
    const itemIds = layout.flatMap((entry) =>
      entry.kind === "item" ? [entry.itemId] : [],
    );
    expect(itemIds).toEqual([
      "plugin-a/panel",
      "__bb__/new-thread",
      "plugin-b/tools",
    ]);
    expect(
      layout.flatMap((entry) =>
        entry.kind === "folder" ? entry.folder.itemIds : [],
      ),
    ).not.toContain("plugin-a/panel");
  });

  it("still draws an empty folder", () => {
    expect(layoutRail(STATE(), ITEMS)[0]).toEqual({
      kind: "folder",
      folder: folderById(STATE(), "folder_a"),
    });
  });
});

describe("railSequence", () => {
  it("lists the ids the rail draws, folders and items alike", () => {
    const state = {
      ...STATE(),
      order: ["plugin-b/tools", "folder_b", "plugin-a/panel"],
    };
    expect(railSequence(state, ITEMS)).toEqual([
      "plugin-b/tools",
      "folder_b",
      "plugin-a/panel",
      "__bb__/new-thread",
      "folder_a",
    ]);
  });
});

describe("placeInOrder", () => {
  const anchored = () => ({
    ...STATE(),
    order: ["folder_a", "folder_b"],
  });

  it("materializes the drawn order to place a folder before a single icon", () => {
    const state = anchored();
    expect(
      placeInOrder(state, ITEMS, "folder_b", "plugin-b/tools").order,
    ).toEqual([
      "folder_a",
      "__bb__/new-thread",
      "plugin-a/panel",
      "folder_b",
      "plugin-b/tools",
    ]);
  });

  it("puts a folder at the very end for a null target", () => {
    expect(placeInOrder(anchored(), ITEMS, "folder_a", null).order).toEqual([
      "folder_b",
      "__bb__/new-thread",
      "plugin-a/panel",
      "plugin-b/tools",
      "folder_a",
    ]);
  });

  it("moves among anchored entries without materializing stale anchors", () => {
    const state = {
      ...STATE(),
      order: ["folder_a", "gone/panel", "folder_b"],
    };
    expect(
      placeInOrder(state, ITEMS, "folder_b", "folder_a").order,
    ).toEqual(["folder_b", "folder_a", "gone/panel"]);
  });

  it("returns the same state for a no-op, a self drop or an unknown id", () => {
    const atEnd = {
      ...STATE(),
      order: [
        "folder_a",
        "plugin-a/panel",
        "__bb__/new-thread",
        "plugin-b/tools",
        "folder_b",
      ],
    };
    expect(placeInOrder(atEnd, ITEMS, "folder_b", null)).toBe(atEnd);
    expect(placeInOrder(atEnd, ITEMS, "folder_a", "folder_a")).toBe(atEnd);
    expect(placeInOrder(atEnd, ITEMS, "gone/panel", null)).toBe(atEnd);
  });
});

describe("setRailOrder", () => {
  const state = () => ({
    ...STATE(),
    order: ["folder_a", "folder_b"],
  });

  it("saves a mixed order of folders and item anchors", () => {
    const before = state();
    const after = setRailOrder(before, [
      "plugin-b/tools",
      "folder_b",
      "folder_a",
      "plugin-a/panel",
    ]);
    expect(after.order).toEqual([
      "plugin-b/tools",
      "folder_b",
      "folder_a",
      "plugin-a/panel",
    ]);
    expect(after.folders).toBe(before.folders);
  });

  it("returns the same state when the order did not change", () => {
    const before = state();
    expect(setRailOrder(before, ["folder_a", "folder_b"])).toBe(before);
  });

  it("rejects a missing folder, a repeat and a blank entry", () => {
    expect(() => setRailOrder(state(), ["folder_a"])).toThrow(
      /missing folder folder_b/,
    );
    expect(() =>
      setRailOrder(state(), ["folder_a", "folder_a", "folder_b"]),
    ).toThrow(/repeat folder_a/);
    expect(() =>
      setRailOrder(state(), ["folder_a", "folder_b", "  "]),
    ).toThrow(/blank/);
  });
});
