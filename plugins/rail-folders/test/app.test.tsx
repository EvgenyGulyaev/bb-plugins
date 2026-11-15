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
    await screen.findByRole("button", { name: "Работа" });

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
    const folderButton = await screen.findByRole("button", { name: "Работа" });
    expect(
      slot.container.querySelector('[data-rail-entry="item:test-plugin/panel-a"]'),
    ).toBeNull();

    fireEvent.click(folderButton);
    const menu = await screen.findByRole("menu", { name: "Работа" });
    expect(
      within(menu).getByRole("menuitem", {
        name: "Панель A, 3 открытые задачи",
      }),
    ).toBeTruthy();
  });

  it("marks the active item and the folder that contains it", async () => {
    const slot = mount({ state: folderState(), activeItemId: PANEL_A.id });
    const folderButton = await screen.findByRole("button", { name: "Работа" });
    expect(folderButton.getAttribute("aria-current")).toBe("page");
    expect(
      slot.getByRole("button", { name: "Панель B" }).getAttribute("aria-current"),
    ).toBeNull();
  });

  it("does not mark a folder active for an unrelated item", async () => {
    const slot = mount({ state: folderState(), activeItemId: PANEL_B.id });
    const folderButton = await screen.findByRole("button", { name: "Работа" });
    expect(folderButton.getAttribute("aria-current")).toBeNull();
    expect(
      slot.getByRole("button", { name: "Панель B" }).getAttribute("aria-current"),
    ).toBe("page");
  });

  it("puts the badge label in an item's accessible name", () => {
    mount();
    expect(screen.getByRole("button", { name: "Панель A, 3 открытые задачи" })).toBeTruthy();
  });

  it("shows a dot on a folder whose member has a badge", async () => {
    const slot = mount({ state: folderState() });
    await screen.findByRole("button", { name: "Работа" });
    expect(slot.container.querySelector("[data-rail-badge-dot]")).not.toBeNull();
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
    const folderButton = await screen.findByRole("button", { name: "Работа" });
    fireEvent.click(folderButton);

    const menu = await screen.findByRole("menu", { name: "Работа" });
    const member = within(menu).getByRole("menuitem", {
      name: "Панель A, 3 открытые задачи",
    });
    fireEvent.click(member);
    expect(slot.inspection.sidebarNavigationCalls).toContainEqual({
      method: "activate",
      itemId: PANEL_A.id,
      target: "current",
    });
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Работа" })).toBeNull());

    fireEvent.click(folderButton);
    const reopened = await screen.findByRole("menu", { name: "Работа" });
    fireEvent.click(
      within(reopened).getByRole("menuitem", { name: "Панель A, 3 открытые задачи" }),
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
    const menu = await screen.findByRole("menu", { name: "Пустая" });
    expect(within(menu).getByText("В папке пусто")).toBeTruthy();

    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("menu", { name: "Пустая" })).toBeNull(),
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
    const menu = await screen.findByRole("menu", { name: "Отключённые" });
    const member = within(menu).getByRole("menuitem", { name: "Отключена" });
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
    const menu = await screen.findByRole("menu", { name: "Скрытые иконки" });
    const hidden = within(menu).getByRole("menuitem", { name: "Скрытая" });
    fireEvent.click(hidden);

    expect(slot.inspection.sidebarNavigationCalls).toEqual([
      { method: "activate", itemId: HIDDEN.id, target: "current" },
    ]);
  });

  it("omits the overflow button when nothing is hidden", () => {
    mount({ items: [NEW_THREAD, PANEL_A] });
    expect(screen.queryByRole("button", { name: "Ещё" })).toBeNull();
  });
});

describe("item context menu", () => {
  it("creates a folder from the icon", async () => {
    const slot = mount();
    fireEvent.contextMenu(screen.getByRole("button", { name: "Панель B" }));

    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Новая папка с этой иконкой/ }),
    );

    await waitFor(() =>
      expect(rpcCalls(slot, "folders_create")).toEqual([
        {
          method: "folders_create",
          input: {
            name: "Панель B",
            icon: "Folder",
            itemIds: [PANEL_B.id],
          },
        },
      ]),
    );
  });

  it("adds the icon to an existing folder through the submenu", async () => {
    const slot = mount({ state: folderState() });
    await screen.findByRole("button", { name: "Работа" });
    fireEvent.contextMenu(screen.getByRole("button", { name: "Панель B" }));

    const subTrigger = await screen.findByRole("menuitem", {
      name: /Добавить в папку/,
    });
    fireEvent.keyDown(subTrigger, { key: "ArrowRight" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Работа" }));

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

    fireEvent.click(await screen.findByRole("button", { name: "Работа" }));
    const menu = await screen.findByRole("menu", { name: "Работа" });
    fireEvent.contextMenu(
      within(menu).getByRole("menuitem", { name: "Панель B" }),
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
  it("renames a folder through the dialog", async () => {
    const slot = mount({ state: folderState() });
    fireEvent.contextMenu(await screen.findByRole("button", { name: "Работа" }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Переименовать папку/ }),
    );

    const input = await screen.findByRole("textbox", { name: "Название папки" });
    fireEvent.change(input, { target: { value: "  Дом  " } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() =>
      expect(rpcCalls(slot, "folders_rename")).toEqual([
        { method: "folders_rename", input: { id: "folder_a", name: "Дом" } },
      ]),
    );
  });

  it("deletes a folder only after confirmation", async () => {
    const slot = mount({ state: folderState() });
    fireEvent.contextMenu(await screen.findByRole("button", { name: "Работа" }));
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

describe("realtime", () => {
  it("reloads the arrangement when another window publishes a change", async () => {
    const slot = mount();
    await waitFor(() => expect(rpcCalls(slot, "rail_state")).toHaveLength(1));

    await slot.behavior.emitRealtime("rail-folders-changed", {});
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
