// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import type { ExperimentalSidebarNavigationItem } from "@get-bb/plugin-sdk/app";

import {
  EMPTY_RAIL_STATE,
  addItemToFolder,
  createFolder,
  type RailFoldersState,
} from "../lib/folders";

// Modules touching @get-bb/plugin-sdk/app bind the runtime at import time, so
// app.tsx may only be imported after loadPluginApp installed it.
const app = await loadPluginApp(() => import("../app"));
const navigation = app.experimentalSidebarNavigations[0]!;
const settingsSection = app.settingsSections[0]!;

function item(
  partial: Partial<ExperimentalSidebarNavigationItem> & {
    id: string;
    label: string;
  },
): ExperimentalSidebarNavigationItem {
  return {
    icon: { kind: "plugin", pluginId: "test-plugin", icon: "LayoutGrid" },
    action: {
      kind: "open-plugin-panel",
      pluginId: "test-plugin",
      panelId: "panel-a",
    },
    isDisabled: false,
    isVisible: true,
    isLoading: false,
    pluginId: "test-plugin",
    shortcut: null,
    badge: null,
    ...partial,
  };
}

const NEW_THREAD = item({
  id: "__bb__/new-thread",
  label: "Новый поток",
  icon: { kind: "host", name: "new-thread" },
  action: { kind: "new-thread" },
  pluginId: null,
  shortcut: { label: "⌘N", ariaKeyShortcuts: "Meta+N" },
});
const PANEL_A = item({
  id: "test-plugin/panel-a",
  label: "Панель A",
  badge: { label: "3 открытые задачи", count: 3 },
});
const PANEL_B = item({ id: "test-plugin/panel-b", label: "Панель B" });
const HIDDEN = item({
  id: "test-plugin/hidden",
  label: "Скрытая",
  isVisible: false,
});
const DISABLED = item({
  id: "test-plugin/off",
  label: "Отключена",
  isDisabled: true,
});
const ITEMS = [NEW_THREAD, PANEL_A, PANEL_B, HIDDEN, DISABLED];

function folderState(): RailFoldersState {
  return createFolder(EMPTY_RAIL_STATE, {
    id: "folder_a",
    name: "Работа",
    icon: "Briefcase",
    itemIds: [PANEL_A.id],
  });
}

function twoFolders(): RailFoldersState {
  return createFolder(folderState(), {
    id: "folder_b",
    name: "Инструменты",
    icon: "Wrench",
  });
}

function mount(
  options: {
    state?: RailFoldersState;
    items?: readonly ExperimentalSidebarNavigationItem[];
    activeItemId?: string | null;
    isHomeActive?: boolean;
    isShortcutModifierHeld?: boolean;
    rpc?: Record<string, (input: unknown) => unknown>;
    settings?: boolean;
  } = {},
): RenderedSlot {
  const renderOptions = {
    rpc: {
      rail_state: () => ({ state: options.state ?? EMPTY_RAIL_STATE }),
      ...options.rpc,
    } as never,
    sidebarNavigation: {
      items: options.items ?? ITEMS,
      activeItemId: options.activeItemId ?? null,
      isHomeActive: options.isHomeActive ?? false,
      isShortcutModifierHeld: options.isShortcutModifierHeld ?? false,
    },
  };

  if (options.settings) {
    return renderSlot(
      { component: settingsSection.component },
      {},
      renderOptions,
    );
  }
  return renderSlot(
    { component: navigation.component },
    {
      isCompactViewport: false,
      placement: "rail",
      experimental_Original: () => null,
    },
    renderOptions,
  );
}

function railEntries(slot: RenderedSlot): string[] {
  return Array.from(
    slot.container.querySelectorAll<HTMLElement>("[data-rail-entry]"),
  ).map((element) => element.dataset.railEntry ?? "");
}

function rpcCalls(slot: RenderedSlot, method: string) {
  return slot.inspection.rpcCalls.filter((call) => call.method === method);
}

afterEach(cleanup);

describe("registration", () => {
  it("registers one rail navigation and one settings section", () => {
    expect(app.experimentalSidebarNavigations).toHaveLength(1);
    expect(navigation).toMatchObject({
      id: "rail-folders",
      title: "Папки рейла",
      placement: "rail",
    });
    expect(navigation.component).toBeTypeOf("function");

    expect(app.settingsSections).toHaveLength(1);
    expect(settingsSection).toMatchObject({
      id: "rail-folders",
      title: "Папки рейла",
    });
    expect(settingsSection.component).toBeTypeOf("function");
  });

  it("registers nothing else that would draw outside the rail", () => {
    expect(app.navPanels).toHaveLength(0);
    expect(app.homepageSections).toHaveLength(0);
    expect(app.experimentalSidebarFooterItems).toHaveLength(0);
  });
});

describe("rail layout", () => {
  it("draws Home, the folder and the ungrouped visible items in order", async () => {
    const slot = mount({ state: folderState() });
    await screen.findByRole("button", { name: /^Работа/ });

    expect(railEntries(slot)).toEqual([
      "home",
      "folder:folder_a",
      "item:__bb__/new-thread",
      "item:test-plugin/panel-b",
      "item:test-plugin/off",
    ]);
  });

  it("moves a grouped icon out of the top level into its folder", async () => {
    const slot = mount({ state: folderState() });
    const folderButton = await screen.findByRole("button", { name: /^Работа/ });
    expect(
      slot.container.querySelector('[data-rail-entry="item:test-plugin/panel-a"]'),
    ).toBeNull();

    fireEvent.click(folderButton);
    const menu = await screen.findByRole("group", { name: /^Работа/ });
    expect(
      within(menu).getByRole("button", {
        name: "Панель A, 3 открытые задачи",
      }),
    ).toBeTruthy();
  });

  it("marks the active item and the folder that contains it", async () => {
    const slot = mount({ state: folderState(), activeItemId: PANEL_A.id });
    const folderButton = await screen.findByRole("button", { name: /^Работа/ });
    expect(folderButton.getAttribute("aria-current")).toBe("true");
    expect(
      slot.getByRole("button", { name: "Панель B" }).getAttribute("aria-current"),
    ).toBeNull();
  });

  it("does not mark a folder active for an unrelated item", async () => {
    const slot = mount({ state: folderState(), activeItemId: PANEL_B.id });
    const folderButton = await screen.findByRole("button", { name: /^Работа/ });
    expect(folderButton.getAttribute("aria-current")).toBeNull();
    expect(
      slot.getByRole("button", { name: "Панель B" }).getAttribute("aria-current"),
    ).toBe("page");
  });

  it("puts the badge label in an item's accessible name", () => {
    mount();
    expect(screen.getByRole("button", { name: "Панель A, 3 открытые задачи" })).toBeTruthy();
  });

  it("shows a dot on a folder whose member has a badge, and names the badge", async () => {
    const slot = mount({ state: folderState() });
    const folderButton = await screen.findByRole("button", { name: /^Работа/ });
    expect(slot.container.querySelector("[data-rail-badge-dot]")).not.toBeNull();
    expect(folderButton.getAttribute("aria-label")).toBe(
      "Работа, 3 открытые задачи",
    );
  });

  it("shows no dot on a folder without badges", async () => {
    const slot = mount({
      state: createFolder(EMPTY_RAIL_STATE, {
        id: "folder_c",
        name: "Чистая",
        icon: "Folder",
        itemIds: [PANEL_B.id],
      }),
    });
    await screen.findByRole("button", { name: "Чистая" });
    expect(slot.container.querySelector("[data-rail-badge-dot]")).toBeNull();
  });

  it("keeps disabled and loading items visible but inert", () => {
    const slot = mount({
      items: [DISABLED, item({ id: "test-plugin/loading", label: "Грузится", isLoading: true })],
    });
    expect(
      (slot.getByRole("button", { name: "Отключена" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(slot.getByRole("button", { name: "Отключена" }));
    fireEvent.click(slot.getByRole("button", { name: "Грузится" }));
    expect(slot.inspection.sidebarNavigationCalls).toEqual([]);
  });

  it("draws a folder as an icon only, with the name in the label and tooltip", async () => {
    const slot = mount({
      state: createFolder(EMPTY_RAIL_STATE, {
        id: "folder_icon_only",
        name: "Работа",
        icon: "Briefcase",
      }),
    });
    const folderButton = await screen.findByRole("button", { name: "Работа" });

    expect(folderButton.textContent).not.toContain("Работа");
    expect(folderButton.getAttribute("title")).toBe("Работа");
    expect(folderButton.getAttribute("aria-label")).toBe("Работа");
  });

  it("opens bb's rail editor from the overflow menu", async () => {
    const slot = mount();
    fireEvent.click(slot.getByRole("button", { name: "Ещё" }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Настроить рейл/ }),
    );
    expect(slot.inspection.sidebarNavigationCalls).toEqual([
      { method: "openCustomize" },
    ]);
  });

  it("keeps the rail editor reachable when nothing is hidden", async () => {
    const slot = mount({ items: [NEW_THREAD, PANEL_A] });
    fireEvent.click(slot.getByRole("button", { name: "Ещё" }));
    expect(
      await screen.findByRole("menuitem", { name: /Настроить рейл/ }),
    ).toBeTruthy();
    expect(slot.queryByText("Скрытая")).toBeNull();
  });
});

describe("activation", () => {
  it("returns home in place, or in a tab with the command modifier", () => {
    const slot = mount();
    const home = slot.getByRole("button", { name: "Домой" });
    fireEvent.click(home);
    fireEvent.click(home, { metaKey: true });

    expect(slot.inspection.sidebarNavigationCalls).toEqual([
      { method: "goHome", target: "current" },
      { method: "goHome", target: "tab" },
    ]);
  });

  it("activates an item in place, or in a split with the command modifier", () => {
    const slot = mount();
    const button = slot.getByRole("button", { name: "Панель B" });
    fireEvent.click(button);
    fireEvent.click(button, { metaKey: true });

    expect(slot.inspection.sidebarNavigationCalls).toEqual([
      { method: "activate", itemId: PANEL_B.id, target: "current" },
      { method: "activate", itemId: PANEL_B.id, target: "split" },
    ]);
  });

  it("reveals shortcut pills only while the modifier is held", () => {
    const cold = mount();
    expect(cold.getByRole("button", { name: "Новый поток" }).getAttribute("aria-keyshortcuts")).toBe("Meta+N");
    expect(cold.container.querySelector("[data-rail-shortcut]")).toBeNull();
    cleanup();

    const warm = mount({ isShortcutModifierHeld: true });
    expect(warm.getByText("⌘N")).toBeTruthy();
  });
});

describe("folder popover", () => {
  it("lists members and activates one in place or in a split", async () => {
    const slot = mount({ state: folderState() });
    const folderButton = await screen.findByRole("button", { name: /^Работа/ });
    fireEvent.click(folderButton);

    const menu = await screen.findByRole("group", { name: /^Работа/ });
    const member = within(menu).getByRole("button", {
      name: "Панель A, 3 открытые задачи",
    });
    fireEvent.click(member);
    expect(slot.inspection.sidebarNavigationCalls).toContainEqual({
      method: "activate",
      itemId: PANEL_A.id,
      target: "current",
    });
    await waitFor(() => expect(screen.queryByRole("group", { name: /^Работа/ })).toBeNull());

    fireEvent.click(folderButton);
    const reopened = await screen.findByRole("group", { name: /^Работа/ });
    fireEvent.click(
      within(reopened).getByRole("button", { name: "Панель A, 3 открытые задачи" }),
      { metaKey: true },
    );
    expect(slot.inspection.sidebarNavigationCalls).toContainEqual({
      method: "activate",
      itemId: PANEL_A.id,
      target: "split",
    });
  });

  it("says so when the folder is empty and closes on Escape", async () => {
    const slot = mount({
      state: createFolder(EMPTY_RAIL_STATE, {
        id: "folder_empty",
        name: "Пустая",
        icon: "Folder",
      }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Пустая" }));
    const menu = await screen.findByRole("group", { name: "Пустая" });
    expect(within(menu).getByText("В папке пусто")).toBeTruthy();

    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("group", { name: "Пустая" })).toBeNull(),
    );
  });

  it("does not activate a disabled member", async () => {
    const slot = mount({
      state: createFolder(EMPTY_RAIL_STATE, {
        id: "folder_off",
        name: "Отключённые",
        icon: "Folder",
        itemIds: [DISABLED.id],
      }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Отключённые" }));
    const menu = await screen.findByRole("group", { name: "Отключённые" });
    const member = within(menu).getByRole("button", { name: "Отключена" });
    expect((member as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(member);
    expect(slot.inspection.sidebarNavigationCalls).toEqual([]);
  });
});

describe("overflow", () => {
  it("keeps hidden items reachable from the overflow menu", async () => {
    const slot = mount();
    expect(screen.queryByRole("button", { name: "Скрытая" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Ещё" }));
    const menu = await screen.findByRole("group", { name: "Скрытые иконки" });
    const hidden = within(menu).getByRole("button", { name: "Скрытая" });
    fireEvent.click(hidden);

    expect(slot.inspection.sidebarNavigationCalls).toEqual([
      { method: "activate", itemId: HIDDEN.id, target: "current" },
    ]);
  });

  it("keeps the overflow menu for the rail editor when nothing is hidden", () => {
    mount({ items: [NEW_THREAD, PANEL_A] });
    expect(screen.getByRole("button", { name: "Ещё" })).toBeTruthy();
  });

  it("keeps a hidden grouped item inside its folder, not in the overflow", async () => {
    mount({
      state: createFolder(EMPTY_RAIL_STATE, {
        id: "folder_hidden",
        name: "Скрытые",
        icon: "Folder",
        itemIds: [HIDDEN.id],
      }),
    });
    expect(await screen.findByRole("button", { name: "Скрытые" })).toBeTruthy();
    // The overflow button is always there for the rail editor, but the grouped
    // hidden icon must not be offered by it.
    fireEvent.click(screen.getByRole("button", { name: "Ещё" }));
    await screen.findByRole("menuitem", { name: /Настроить рейл/ });
    expect(
      screen.queryByRole("button", { name: "Скрытая" }),
    ).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menuitem", { name: /Настроить рейл/ })).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Скрытые" }));
    const group = await screen.findByRole("group", { name: "Скрытые" });
    expect(within(group).getByRole("button", { name: "Скрытая" })).toBeTruthy();
  });
});

describe("item context menu", () => {
  it("opens the create-folder dialog instead of creating at once", async () => {
    const slot = mount();
    fireEvent.contextMenu(screen.getByRole("button", { name: "Панель B" }));

    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Новая папка/ }),
    );

    const dialog = await screen.findByRole("dialog");
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
    expect(within(dialog).getByRole("heading", { name: "Новая папка" })).toBeTruthy();
    expect(rpcCalls(slot, "folders_create")).toEqual([]);
  });

  it("creates an empty folder with the picked icon and typed name", async () => {
    const slot = mount();
    fireEvent.contextMenu(screen.getByRole("button", { name: "Панель B" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Новая папка/ }));

    const dialog = await screen.findByRole("dialog");
    const name = within(dialog).getByRole("textbox", { name: "Название папки" });
    expect((name as HTMLInputElement).value).toBe("Папка");
    fireEvent.change(name, { target: { value: "  Инструменты  " } });
    fireEvent.click(
      within(dialog).getByRole("radio", { name: "Briefcase" }),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "OK" }));

    await waitFor(() =>
      expect(rpcCalls(slot, "folders_create")).toEqual([
        {
          method: "folders_create",
          input: { name: "Инструменты", icon: "Briefcase" },
        },
      ]),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("does not pre-fill the new folder with the clicked icon's name", async () => {
    const slot = mount();
    fireEvent.contextMenu(screen.getByRole("button", { name: "Панель B" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Новая папка/ }));

    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "OK" }));
    await waitFor(() =>
      expect(rpcCalls(slot, "folders_create")).toEqual([
        { method: "folders_create", input: { name: "Папка", icon: "Folder" } },
      ]),
    );
  });

  it("moves through the icon grid with arrow keys", async () => {
    mount();
    fireEvent.contextMenu(screen.getByRole("button", { name: "Панель B" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Новая папка/ }));

    const dialog = await screen.findByRole("dialog");
    const first = within(dialog).getByRole("radio", { name: "Folder" });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });

    const second = within(dialog).getByRole("radio", { name: "Briefcase" });
    expect(second.getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(second, { key: "ArrowLeft" });
    expect(
      within(dialog).getByRole("radio", { name: "Folder" }).getAttribute(
        "aria-checked",
      ),
    ).toBe("true");
  });

  it("closes the create dialog on Cancel and Escape without creating", async () => {
    const slot = mount();
    fireEvent.contextMenu(screen.getByRole("button", { name: "Панель B" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Новая папка/ }));

    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Отмена",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.contextMenu(screen.getByRole("button", { name: "Панель B" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Новая папка/ }));
    const reopened = await screen.findByRole("dialog");
    fireEvent.keyDown(reopened, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    expect(rpcCalls(slot, "folders_create")).toEqual([]);
  });

  it("keeps the whole menu reachable when a folder already exists", async () => {
    const slot = mount({ state: folderState() });
    await screen.findByRole("button", { name: /^Работа/ });
    fireEvent.contextMenu(screen.getByRole("button", { name: "Панель B" }));

    const subTrigger = await screen.findByRole("menuitem", {
      name: /Добавить в папку/,
    });
    fireEvent.keyDown(subTrigger, { key: "ArrowRight" });
    fireEvent.click(await screen.findByRole("menuitem", { name: /^Работа/ }));

    await waitFor(() =>
      expect(rpcCalls(slot, "folders_add_item")).toEqual([
        {
          method: "folders_add_item",
          input: { folderId: "folder_a", itemId: PANEL_B.id },
        },
      ]),
    );
  });

  it("offers to remove a grouped icon from its folder menu", async () => {
    const slot = mount({
      state: addItemToFolder(folderState(), "folder_a", PANEL_B.id),
    });

    fireEvent.click(await screen.findByRole("button", { name: /^Работа/ }));
    const menu = await screen.findByRole("group", { name: /^Работа/ });
    fireEvent.contextMenu(
      within(menu).getByRole("button", { name: "Панель B" }),
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Убрать из папки/ }),
    );

    await waitFor(() =>
      expect(rpcCalls(slot, "folders_remove_item")).toEqual([
        { method: "folders_remove_item", input: { itemId: PANEL_B.id } },
      ]),
    );
  });

  it("opens plugin details only for plugin-owned items", async () => {
    const slot = mount();

    fireEvent.contextMenu(screen.getByRole("button", { name: "Новый поток" }));
    await screen.findByRole("menu");
    expect(screen.queryByRole("menuitem", { name: /Детали плагина/ })).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    fireEvent.contextMenu(screen.getByRole("button", { name: "Панель B" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Детали плагина/ }));

    expect(slot.inspection.sidebarNavigationCalls).toEqual([
      { method: "openDetails", itemId: PANEL_B.id },
    ]);
  });
});

describe("folder context menu", () => {
  it("renames a folder through the dialog's icon picker", async () => {
    const slot = mount({ state: folderState() });
    fireEvent.contextMenu(await screen.findByRole("button", { name: /^Работа/ }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Переименовать папку/ }),
    );

    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByRole("textbox", { name: "Название папки" });
    fireEvent.change(input, { target: { value: "  Дом  " } });
    fireEvent.click(within(dialog).getByRole("radio", { name: "House" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Сохранить" }));

    await waitFor(() =>
      expect(rpcCalls(slot, "folders_rename")).toEqual([
        { method: "folders_rename", input: { id: "folder_a", name: "Дом" } },
      ]),
    );
    await waitFor(() =>
      expect(rpcCalls(slot, "folders_set_icon")).toEqual([
        { method: "folders_set_icon", input: { id: "folder_a", icon: "House" } },
      ]),
    );
  });

  it("keeps the rename dialog's icon when only the name changes", async () => {
    const slot = mount({ state: folderState() });
    fireEvent.contextMenu(await screen.findByRole("button", { name: /^Работа/ }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Переименовать папку/ }),
    );

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("radio", { name: "Briefcase" }).getAttribute(
        "aria-checked",
      ),
    ).toBe("true");
    fireEvent.click(within(dialog).getByRole("button", { name: "Сохранить" }));

    await waitFor(() =>
      expect(rpcCalls(slot, "folders_rename")).toEqual([
        { method: "folders_rename", input: { id: "folder_a", name: "Работа" } },
      ]),
    );
    expect(rpcCalls(slot, "folders_set_icon")).toEqual([]);
  });

  it("shows a folder's saved icon even when it is not in the offered set", async () => {
    const slot = mount({
      state: createFolder(EMPTY_RAIL_STATE, {
        id: "folder_custom",
        name: "Своя",
        icon: "Gauge",
      }),
    });
    fireEvent.contextMenu(
      await screen.findByRole("button", { name: "Своя" }),
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Переименовать папку/ }),
    );

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("radio", { name: "Gauge" }).getAttribute(
        "aria-checked",
      ),
    ).toBe("true");

    fireEvent.click(within(dialog).getByRole("button", { name: "Сохранить" }));
    await waitFor(() =>
      expect(rpcCalls(slot, "folders_rename")).toEqual([
        { method: "folders_rename", input: { id: "folder_custom", name: "Своя" } },
      ]),
    );
    expect(rpcCalls(slot, "folders_set_icon")).toEqual([]);
  });

  it("deletes a folder only after confirmation", async () => {
    const slot = mount({ state: folderState() });
    fireEvent.contextMenu(await screen.findByRole("button", { name: /^Работа/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Удалить папку/ }));

    await screen.findByText("Удалить папку?");
    expect(rpcCalls(slot, "folders_delete")).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Удалить папку" }));

    await waitFor(() =>
      expect(rpcCalls(slot, "folders_delete")).toEqual([
        { method: "folders_delete", input: { id: "folder_a" } },
      ]),
    );
  });
});

describe("drag and drop", () => {
  function transfer() {
    const store: Record<string, string> = {};
    return {
      store,
      // A real DataTransfer exposes the types it was written with, which the
      // drop targets read during dragover.
      get types() {
        return Object.keys(store);
      },
      setData: (type: string, value: string) => {
        store[type] = value;
      },
      getData: (type: string) => store[type] ?? "",
      effectAllowed: "move",
      dropEffect: "move",
    };
  }

  // jsdom has no layout, so a drop target needs a rectangle before its halves
  // can be told apart.
  function withRect(element: HTMLElement, top = 0, height = 20): HTMLElement {
    element.getBoundingClientRect = () =>
      ({
        top,
        bottom: top + height,
        height,
        left: 0,
        right: 40,
        width: 40,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;
    return element;
  }

  it("drops a rail icon on a folder and adds it there", async () => {
    const slot = mount({
      state: createFolder(EMPTY_RAIL_STATE, {
        id: "folder_a",
        name: "Работа",
        icon: "Briefcase",
      }),
    });
    const folderButton = await screen.findByRole("button", { name: /^Работа/ });
    const icon = slot.container.querySelector<HTMLElement>(
      `[data-rail-entry="item:${PANEL_B.id}"]`,
    )!;
    expect(icon.draggable).toBe(true);

    const data = transfer();
    fireEvent.dragStart(icon, { dataTransfer: data });
    expect(data.getData("text/rail-item-id")).toBe(PANEL_B.id);
    fireEvent.dragOver(folderButton, { dataTransfer: data });
    expect(folderButton.getAttribute("data-drop-active")).toBe("");
    fireEvent.drop(folderButton, { dataTransfer: data });

    await waitFor(() =>
      expect(rpcCalls(slot, "folders_add_item")).toEqual([
        {
          method: "folders_add_item",
          input: { folderId: "folder_a", itemId: PANEL_B.id },
        },
      ]),
    );
  });

  it("clears the drop highlight when the drag leaves the folder", async () => {
    const slot = mount({
      state: createFolder(EMPTY_RAIL_STATE, {
        id: "folder_a",
        name: "Работа",
        icon: "Briefcase",
      }),
    });
    const folderButton = await screen.findByRole("button", { name: /^Работа/ });
    const icon = slot.container.querySelector<HTMLElement>(
      `[data-rail-entry="item:${PANEL_B.id}"]`,
    )!;
    const data = transfer();
    fireEvent.dragStart(icon, { dataTransfer: data });

    fireEvent.dragOver(folderButton, { dataTransfer: data });
    expect(folderButton.getAttribute("data-drop-active")).toBe("");
    fireEvent.dragLeave(folderButton, { dataTransfer: data });
    expect(folderButton.getAttribute("data-drop-active")).toBeNull();
    expect(rpcCalls(slot, "folders_add_item")).toEqual([]);
  });

  it("drags a folder member out to the ungrouped area and removes it", async () => {
    const slot = mount({
      state: addItemToFolder(folderState(), "folder_a", PANEL_B.id),
    });
    fireEvent.click(await screen.findByRole("button", { name: /^Работа/ }));
    const menu = await screen.findByRole("group", { name: /^Работа/ });
    const row = within(menu).getByRole("button", { name: "Панель B" });
    expect(row.closest("[data-rail-menu-row]")?.getAttribute("draggable")).toBe(
      "true",
    );

    const dropZone = slot.container.querySelector<HTMLElement>(
      "[data-rail-dropzone]",
    )!;
    expect(dropZone).not.toBeNull();

    const data = transfer();
    fireEvent.dragStart(row.parentElement!, { dataTransfer: data });
    expect(data.getData("text/rail-item-id")).toBe(PANEL_B.id);
    fireEvent.dragOver(dropZone, { dataTransfer: data });
    expect(dropZone.getAttribute("data-drop-active")).toBe("");
    fireEvent.drop(dropZone, { dataTransfer: data });

    await waitFor(() =>
      expect(rpcCalls(slot, "folders_remove_item")).toEqual([
        { method: "folders_remove_item", input: { itemId: PANEL_B.id } },
      ]),
    );
  });

  it("reorders members by dragging one row onto another", async () => {
    const slot = mount({
      state: createFolder(EMPTY_RAIL_STATE, {
        id: "folder_a",
        name: "Работа",
        icon: "Briefcase",
        itemIds: [PANEL_A.id, PANEL_B.id],
      }),
    });
    fireEvent.click(await screen.findByRole("button", { name: /^Работа/ }));
    const menu = await screen.findByRole("group", { name: /^Работа/ });
    const source = within(menu).getByRole("button", {
      name: "Панель A, 3 открытые задачи",
    }).parentElement!;
    const target = withRect(
      within(menu).getByRole("button", { name: "Панель B" }).parentElement!,
    );

    const data = transfer();
    fireEvent.dragStart(source, { dataTransfer: data });
    fireEvent.dragOver(target, { dataTransfer: data, clientY: 19 });
    expect(target.getAttribute("data-reorder-indicator")).toBe("after");
    expect(
      target.querySelector('[data-reorder-line="after"]'),
    ).not.toBeNull();
    fireEvent.drop(target, { dataTransfer: data, clientY: 19 });

    await waitFor(() =>
      expect(rpcCalls(slot, "folders_reorder_items")).toEqual([
        {
          method: "folders_reorder_items",
          input: { id: "folder_a", itemIds: [PANEL_B.id, PANEL_A.id] },
        },
      ]),
    );
  });

  it("shifts the insert index when dragging a member below a later row", async () => {
    const panelC = item({ id: "test-plugin/panel-c", label: "Панель C" });
    const panelD = item({ id: "test-plugin/panel-d", label: "Панель D" });
    const members = [PANEL_A, PANEL_B, panelC, panelD];
    const slot = mount({
      state: createFolder(EMPTY_RAIL_STATE, {
        id: "folder_a",
        name: "Работа",
        icon: "Briefcase",
        itemIds: members.map((member) => member.id),
      }),
      items: members,
    });
    fireEvent.click(await screen.findByRole("button", { name: /^Работа/ }));
    const menu = await screen.findByRole("group", { name: /^Работа/ });
    const source = within(menu).getByRole("button", {
      name: "Панель A, 3 открытые задачи",
    }).parentElement!;
    const target = withRect(
      within(menu).getByRole("button", { name: "Панель C" }).parentElement!,
    );

    const data = transfer();
    fireEvent.dragStart(source, { dataTransfer: data });
    fireEvent.dragOver(target, { dataTransfer: data, clientY: 19 });
    fireEvent.drop(target, { dataTransfer: data, clientY: 19 });

    await waitFor(() =>
      expect(rpcCalls(slot, "folders_reorder_items")).toEqual([
        {
          method: "folders_reorder_items",
          input: {
            id: "folder_a",
            itemIds: [PANEL_B.id, panelC.id, PANEL_A.id, panelD.id],
          },
        },
      ]),
    );
  });

  it("keeps a stale member's slot when reordering the visible rows", async () => {
    const gone = "plugin-a/gone";
    const slot = mount({
      state: createFolder(EMPTY_RAIL_STATE, {
        id: "folder_a",
        name: "Работа",
        icon: "Briefcase",
        itemIds: [PANEL_A.id, gone, PANEL_B.id],
      }),
    });
    fireEvent.click(await screen.findByRole("button", { name: /^Работа/ }));
    const menu = await screen.findByRole("group", { name: /^Работа/ });
    const source = within(menu).getByRole("button", {
      name: "Панель A, 3 открытые задачи",
    }).parentElement!;
    const target = withRect(
      within(menu).getByRole("button", { name: "Панель B" }).parentElement!,
    );

    const data = transfer();
    fireEvent.dragStart(source, { dataTransfer: data });
    fireEvent.dragOver(target, { dataTransfer: data, clientY: 19 });
    fireEvent.drop(target, { dataTransfer: data, clientY: 19 });

    await waitFor(() =>
      expect(rpcCalls(slot, "folders_reorder_items")).toEqual([
        {
          method: "folders_reorder_items",
          input: { id: "folder_a", itemIds: [PANEL_B.id, gone, PANEL_A.id] },
        },
      ]),
    );
  });

  it("drags a folder onto another folder to move it there", async () => {
    const slot = mount({ state: twoFolders() });
    await screen.findByRole("button", { name: /^Работа/ });
    const source = slot.container.querySelector<HTMLElement>(
      '[data-rail-folder-drag="folder_a"]',
    )!;
    const target = withRect(
      await screen.findByRole("button", { name: "Инструменты" }),
    );
    expect(source).not.toBeNull();
    expect(source.getAttribute("draggable")).toBe("true");

    const data = transfer();
    fireEvent.dragStart(source, { dataTransfer: data });
    expect(data.getData("text/rail-folder-id")).toBe("folder_a");
    fireEvent.dragOver(target, { dataTransfer: data, clientY: 19 });
    expect(
      slot.container.querySelector('[data-folder-drop-line="after"]'),
    ).not.toBeNull();
    fireEvent.drop(target, { dataTransfer: data, clientY: 19 });

    await waitFor(() =>
      expect(rpcCalls(slot, "folders_reorder")).toEqual([
        {
          method: "folders_reorder",
          input: { id: "folder_a", index: 1 },
        },
      ]),
    );
  });

  it("shifts the folder index when dragging it below a later sibling", async () => {
    const slot = mount({
      state: createFolder(twoFolders(), {
        id: "folder_c",
        name: "Прочее",
        icon: "Folder",
      }),
    });
    await screen.findByRole("button", { name: /^Работа/ });
    const source = slot.container.querySelector<HTMLElement>(
      '[data-rail-folder-drag="folder_a"]',
    )!;
    const target = withRect(
      await screen.findByRole("button", { name: "Инструменты" }),
    );

    const data = transfer();
    fireEvent.dragStart(source, { dataTransfer: data });
    fireEvent.dragOver(target, { dataTransfer: data, clientY: 19 });
    fireEvent.drop(target, { dataTransfer: data, clientY: 19 });

    await waitFor(() =>
      expect(rpcCalls(slot, "folders_reorder")).toEqual([
        {
          method: "folders_reorder",
          input: { id: "folder_a", index: 1 },
        },
      ]),
    );
  });

  it("moves a folder to the end when dropped on the free rail", async () => {
    const slot = mount({ state: twoFolders() });
    await screen.findByRole("button", { name: /^Работа/ });
    const source = slot.container.querySelector<HTMLElement>(
      '[data-rail-folder-drag="folder_a"]',
    )!;
    const dropZone = slot.container.querySelector<HTMLElement>(
      "[data-rail-dropzone]",
    )!;

    const data = transfer();
    fireEvent.dragStart(source, { dataTransfer: data });
    fireEvent.dragOver(dropZone, { dataTransfer: data });
    expect(dropZone.getAttribute("data-drop-active")).toBe("");
    fireEvent.drop(dropZone, { dataTransfer: data });

    await waitFor(() =>
      expect(rpcCalls(slot, "folders_reorder")).toEqual([
        {
          method: "folders_reorder",
          input: { id: "folder_a", index: 1 },
        },
      ]),
    );
  });

  it("keeps the folder button as the popover trigger inside the drag wrapper", async () => {
    const slot = mount({ state: folderState() });
    const button = await screen.findByRole("button", { name: /^Работа/ });
    const wrapper = slot.container.querySelector<HTMLElement>(
      '[data-rail-folder-drag="folder_a"]',
    )!;

    expect(wrapper).not.toBe(button);
    expect(wrapper.getAttribute("draggable")).toBe("true");
    expect(button.getAttribute("draggable")).toBeNull();

    fireEvent.click(button);
    expect(await screen.findByRole("group", { name: /^Работа/ })).toBeTruthy();
  });

  it("does not offer the rail as a target for an icon that is already there", async () => {
    const slot = mount();
    const icon = slot.container.querySelector<HTMLElement>(
      `[data-rail-entry="item:${PANEL_B.id}"]`,
    )!;
    const dropZone = slot.container.querySelector<HTMLElement>(
      "[data-rail-dropzone]",
    )!;

    const data = transfer();
    fireEvent.dragStart(icon, { dataTransfer: data });
    fireEvent.dragOver(dropZone, { dataTransfer: data });
    expect(dropZone.getAttribute("data-drop-active")).toBeNull();
    fireEvent.drop(dropZone, { dataTransfer: data });

    expect(rpcCalls(slot, "folders_remove_item")).toEqual([]);
  });

  it("keeps the split-drag contract on the icon button, not the drag wrapper", async () => {
    const slot = mount({ items: [NEW_THREAD, PANEL_B] });
    const button = slot.getByRole("button", { name: "Панель B" });

    fireEvent.pointerDown(button);
    expect(slot.inspection.sidebarNavigationCalls).toContainEqual({
      method: "beginSplitDrag",
      itemId: PANEL_B.id,
    });

    const wrapper = slot.container.querySelector<HTMLElement>(
      `[data-rail-entry="item:${PANEL_B.id}"]`,
    )!;
    expect(wrapper).not.toBe(button);
    expect(wrapper.getAttribute("draggable")).toBe("true");

    slot.inspection.sidebarNavigationCalls.length = 0;
    fireEvent.pointerDown(wrapper);
    expect(slot.inspection.sidebarNavigationCalls).toEqual([]);
  });

  it("keeps the split-drag contract on a popover member row too", async () => {
    const slot = mount({ state: folderState() });
    fireEvent.click(await screen.findByRole("button", { name: /^Работа/ }));
    const menu = await screen.findByRole("group", { name: /^Работа/ });
    const row = within(menu).getByRole("button", {
      name: "Панель A, 3 открытые задачи",
    });

    fireEvent.pointerDown(row);
    expect(slot.inspection.sidebarNavigationCalls).toContainEqual({
      method: "beginSplitDrag",
      itemId: PANEL_A.id,
    });
  });
});

describe("realtime", () => {
  it("reloads the arrangement when another window publishes a change", async () => {
    const slot = mount();
    await waitFor(() => expect(rpcCalls(slot, "rail_state")).toHaveLength(1));

    await slot.behavior.emitRealtime("rail-folders-changed", {});
    await waitFor(() => expect(rpcCalls(slot, "rail_state")).toHaveLength(2));
  });

  it("reconciles after a reconnection, where signals are not replayed", async () => {
    const slot = mount();
    await waitFor(() => expect(rpcCalls(slot, "rail_state")).toHaveLength(1));

    await slot.behavior.setRealtimeConnectionState("reconnecting");
    await slot.behavior.setRealtimeConnectionState("connected");
    await waitFor(() => expect(rpcCalls(slot, "rail_state")).toHaveLength(2));
  });
});

describe("settings section", () => {
  it("creates a folder with the entered name and icon", async () => {
    const slot = mount({ settings: true });
    await screen.findByRole("textbox", { name: "Название новой папки" });

    fireEvent.change(screen.getByRole("textbox", { name: "Название новой папки" }), {
      target: { value: "Работа" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Иконка новой папки" }), {
      target: { value: "Briefcase" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Создать папку/ }));

    await waitFor(() =>
      expect(rpcCalls(slot, "folders_create")).toEqual([
        {
          method: "folders_create",
          input: { name: "Работа", icon: "Briefcase" },
        },
      ]),
    );
  });

  it("renames and re-icons an existing folder", async () => {
    const slot = mount({ state: folderState(), settings: true });
    const nameInput = await screen.findByRole("textbox", {
      name: "Название папки Работа",
    });
    const iconInput = screen.getByRole("textbox", { name: "Иконка папки Работа" });
    fireEvent.change(nameInput, { target: { value: "Дом" } });
    fireEvent.change(iconInput, { target: { value: "House" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() =>
      expect(rpcCalls(slot, "folders_rename")).toEqual([
        { method: "folders_rename", input: { id: "folder_a", name: "Дом" } },
      ]),
    );
    await waitFor(() =>
      expect(rpcCalls(slot, "folders_set_icon")).toEqual([
        { method: "folders_set_icon", input: { id: "folder_a", icon: "House" } },
      ]),
    );
  });

  it("reorders folders and disables the edge buttons", async () => {
    const slot = mount({ state: twoFolders(), settings: true });
    await screen.findByRole("textbox", { name: "Название папки Работа" });

    expect(
      (screen.getByRole("button", { name: "Выше: Работа" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Ниже: Работа" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Ниже: Работа" }));
    await waitFor(() =>
      expect(rpcCalls(slot, "folders_move")).toEqual([
        {
          method: "folders_move",
          input: { id: "folder_a", direction: "down" },
        },
      ]),
    );
  });

  it("reorders folder members with the arrow buttons", async () => {
    const slot = mount({
      state: createFolder(EMPTY_RAIL_STATE, {
        id: "folder_a",
        name: "Работа",
        icon: "Briefcase",
        itemIds: [PANEL_A.id, PANEL_B.id],
      }),
      settings: true,
    });
    await screen.findByRole("textbox", { name: "Название папки Работа" });

    const firstUp = screen.getByRole("button", {
      name: `Выше в папке: ${PANEL_A.id}`,
    }) as HTMLButtonElement;
    const firstDown = screen.getByRole("button", {
      name: `Ниже в папке: ${PANEL_A.id}`,
    }) as HTMLButtonElement;
    const lastDown = screen.getByRole("button", {
      name: `Ниже в папке: ${PANEL_B.id}`,
    }) as HTMLButtonElement;
    expect(firstUp.disabled).toBe(true);
    expect(firstDown.disabled).toBe(false);
    expect(lastDown.disabled).toBe(true);

    fireEvent.click(firstDown);
    await waitFor(() =>
      expect(rpcCalls(slot, "folders_reorder_items")).toEqual([
        {
          method: "folders_reorder_items",
          input: { id: "folder_a", itemIds: [PANEL_B.id, PANEL_A.id] },
        },
      ]),
    );
  });

  it("deletes a folder after confirmation", async () => {
    const slot = mount({ state: folderState(), settings: true });
    fireEvent.click(
      await screen.findByRole("button", { name: "Удалить папку Работа" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Удалить папку" }));

    await waitFor(() =>
      expect(rpcCalls(slot, "folders_delete")).toEqual([
        { method: "folders_delete", input: { id: "folder_a" } },
      ]),
    );
  });

  it("explains the empty state", async () => {
    mount({ settings: true });
    expect(
      await screen.findByText(/Папок пока нет/),
    ).toBeTruthy();
  });
});
