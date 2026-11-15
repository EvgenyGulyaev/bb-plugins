import { describe, expect, it } from "vitest";

import {
  EMPTY_RAIL_STATE,
  addItemToFolder,
  createFolder,
  deleteFolder,
  folderById,
  folderMembers,
  folderOfItem,
  layoutRail,
  moveFolder,
  normalizeState,
  railFoldersStateSchema,
  removeItemFromFolder,
  renameFolder,
  setFolderIcon,
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

  it("moves a folder past the nearest folder, leaving item slots alone", () => {
    const state = {
      ...STATE(),
      order: ["__bb__/new-thread", "folder_a", "plugin-a/panel", "folder_b"],
    };
    expect(moveFolder(state, "folder_b", "up").order).toEqual([
      "__bb__/new-thread",
      "folder_b",
      "plugin-a/panel",
      "folder_a",
    ]);
    expect(moveFolder(state, "folder_a", "up").order).toEqual(
      state.order,
    );
    expect(moveFolder(state, "folder_a", "up")).toBe(state);
    expect(moveFolder(state, "folder_b", "down")).toBe(state);
  });
});

describe("layoutRail", () => {
  it("places folders by order and ungrouped items by the hook order", () => {
    const state = {
      ...STATE(),
      order: ["plugin-b/tools", "folder_b", "plugin-a/panel"],
    };
    expect(layoutRail(state, ITEMS)).toEqual([
      { kind: "item", itemId: "plugin-b/tools" },
      { kind: "folder", folder: folderById(state, "folder_b") },
      { kind: "item", itemId: "plugin-a/panel" },
      { kind: "folder", folder: folderById(state, "folder_a") },
      { kind: "item", itemId: "__bb__/new-thread" },
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
