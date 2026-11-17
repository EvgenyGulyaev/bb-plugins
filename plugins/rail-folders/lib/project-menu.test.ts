// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectPathItem } from "./project-paths";
import {
  buildProjectMenuModel,
  createProjectPathMenuMount,
  parseProjectMenuLabel,
} from "./project-menu";

function item(partial: Partial<ProjectPathItem> & { path: string }): ProjectPathItem {
  return {
    projectId: "proj_1",
    projectName: "picker-routes",
    ...partial,
  };
}

const HOST_ITEM_CLASS =
  "bb-menu-item data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[last-hovered]:bg-state-hover data-[last-hovered]:text-foreground";
const HIGHLIGHT_ATTRIBUTE = "data-last-hovered";

function menu(
  items: string[],
  label = "picker-routes actions",
  className = "bb-menu-item",
): HTMLElement {
  const menu = document.createElement("div");
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", label);
  for (const text of items) {
    const row = document.createElement("div");
    row.setAttribute("role", "menuitem");
    row.setAttribute("tabindex", "-1");
    row.className = className;
    row.textContent = text;
    menu.appendChild(row);
  }
  document.body.appendChild(menu);
  return menu;
}

function labels(menuElement: HTMLElement): string[] {
  return Array.from(menuElement.querySelectorAll('[role="menuitem"]')).map(
    (element) => element.textContent ?? "",
  );
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function response(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");

function setClipboard(value: { writeText: (text: string) => Promise<void> } | undefined) {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value });
}

const pendingDisposers: Array<() => void> = [];

afterEach(() => {
  for (const dispose of pendingDisposers.splice(0)) dispose();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (clipboardDescriptor !== undefined) {
    Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
  } else {
    Reflect.deleteProperty(navigator, "clipboard");
  }
});

describe("parseProjectMenuLabel", () => {
  it("strips the host's ` actions` suffix", () => {
    expect(parseProjectMenuLabel("picker-routes actions")).toBe("picker-routes");
    expect(parseProjectMenuLabel("  Мой проект   actions ")).toBe("Мой проект");
  });

  it("ignores labels that are not a project actions menu", () => {
    expect(parseProjectMenuLabel(null)).toBe(null);
    expect(parseProjectMenuLabel("")).toBe(null);
    expect(parseProjectMenuLabel("actions")).toBe(null);
    expect(parseProjectMenuLabel("picker-routes")).toBe(null);
    expect(parseProjectMenuLabel("picker-routes menu")).toBe(null);
  });
});

describe("buildProjectMenuModel", () => {
  it("offers nothing when the project has no checkout", () => {
    expect(buildProjectMenuModel([])).toEqual({ entries: [], copyAll: null });
  });

  it("offers a single copy action for one checkout", () => {
    const model = buildProjectMenuModel([
      item({ environmentName: "main", path: "/work/picker-routes" }),
    ]);
    expect(model).toEqual({
      entries: [{ kind: "copy", label: "Скопировать путь", path: "/work/picker-routes" }],
      copyAll: null,
    });
  });

  it("labels every checkout with its environment and appends copy-all", () => {
    const model = buildProjectMenuModel([
      item({ environmentName: "main", path: "/work/picker-routes" }),
      item({ environmentName: "feat", path: "/work/picker-routes-feat" }),
    ]);
    expect(model.entries).toEqual([
      { kind: "copy", label: "main: /work/picker-routes", path: "/work/picker-routes" },
      {
        kind: "copy",
        label: "feat: /work/picker-routes-feat",
        path: "/work/picker-routes-feat",
      },
      { kind: "copy-all", label: "Скопировать все пути", path: null },
    ]);
    expect(model.copyAll).toBe("/work/picker-routes\n/work/picker-routes-feat");
  });

  it("falls back to the branch, then the project name, and drops duplicates", () => {
    const model = buildProjectMenuModel([
      item({ branchName: "feat/x", path: "/a" }),
      item({ path: "/a" }),
      item({ path: "/b" }),
    ]);
    expect(model.entries.map((entry) => entry.label)).toEqual([
      "feat/x: /a",
      "picker-routes: /b",
      "Скопировать все пути",
    ]);
  });
});

describe("project path menu mount", () => {
  it("adds copy items before the last host item, keeping the host classes", async () => {
    const hostMenu = menu(["Настройки проекта", "Переименовать", "Убрать"]);
    const writeClipboard = vi.fn(async () => {});
    const mount = createProjectPathMenuMount({
      fetchItems: async () => [item({ environmentName: "main", path: "/work/picker-routes" })],
      writeClipboard,
    });
    const controller = new AbortController();
    const dispose = mount({ pluginId: "rail-folders", generation: 1, signal: controller.signal });

    await flush();

    expect(labels(hostMenu)).toEqual([
      "Настройки проекта",
      "Переименовать",
      "Скопировать путь",
      "Убрать",
    ]);
    const copy = hostMenu.querySelector<HTMLElement>('[data-rail-folders-action="copy"]')!;
    expect(copy.className).toBe("bb-menu-item");
    expect(copy.getAttribute("title")).toBe("/work/picker-routes");
    expect(copy.getAttribute("role")).toBe("menuitem");
    expect(copy.getAttribute("tabindex")).toBe("-1");
    expect(hostMenu.querySelector('[role="separator"]')).not.toBe(null);

    copy.click();
    await flush();
    expect(writeClipboard).toHaveBeenCalledWith("/work/picker-routes");

    dispose();
    expect(document.querySelector('[data-rail-folders-action]')).toBe(null);
    expect(document.querySelector('[role="separator"]')).toBe(null);
  });

  it("closes the host menu with Escape after a successful copy", async () => {
    const hostMenu = menu(["Настройки проекта", "Убрать"]);
    const keys: string[] = [];
    document.addEventListener("keydown", (event) => keys.push(event.key));
    const mount = createProjectPathMenuMount({
      fetchItems: async () => [item({ path: "/work/picker-routes" })],
      writeClipboard: async () => {},
    });
    const dispose = mount({
      pluginId: "rail-folders",
      generation: 1,
      signal: new AbortController().signal,
    });
    await flush();

    hostMenu.querySelector<HTMLElement>('[data-rail-folders-action="copy"]')!.click();
    await flush();

    expect(keys).toEqual(["Escape"]);
    dispose();
  });

  it("reports a failed clipboard write and keeps the menu open", async () => {
    const hostMenu = menu(["Настройки проекта", "Убрать"]);
    const keys: string[] = [];
    document.addEventListener("keydown", (event) => keys.push(event.key));
    const mount = createProjectPathMenuMount({
      fetchItems: async () => [item({ path: "/work/picker-routes" })],
      writeClipboard: async () => {
        throw new Error("denied");
      },
    });
    const dispose = mount({
      pluginId: "rail-folders",
      generation: 1,
      signal: new AbortController().signal,
    });
    await flush();

    const copy = hostMenu.querySelector<HTMLElement>('[data-rail-folders-action="copy"]')!;
    copy.click();
    await flush();

    expect(copy.textContent).toBe("Не удалось скопировать");
    expect(keys).toEqual([]);
    dispose();
  });

  it("adds one item per checkout plus copy-all when several exist", async () => {
    const hostMenu = menu(["Настройки проекта", "Убрать"]);
    const writeClipboard = vi.fn(async () => {});
    const mount = createProjectPathMenuMount({
      fetchItems: async () => [
        item({ environmentName: "main", path: "/work/a" }),
        item({ environmentName: "feat", path: "/work/b" }),
      ],
      writeClipboard,
    });
    const dispose = mount({
      pluginId: "rail-folders",
      generation: 1,
      signal: new AbortController().signal,
    });
    await flush();

    expect(labels(hostMenu)).toEqual([
      "Настройки проекта",
      "main: /work/a",
      "feat: /work/b",
      "Скопировать все пути",
      "Убрать",
    ]);

    hostMenu.querySelector<HTMLElement>('[data-rail-folders-action="copy-all"]')!.click();
    await flush();
    expect(writeClipboard).toHaveBeenCalledWith("/work/a\n/work/b");
    dispose();
  });

  it("leaves the menu alone when the project has no checkout", async () => {
    const hostMenu = menu(["Настройки проекта", "Убрать"]);
    const mount = createProjectPathMenuMount({
      fetchItems: async () => [],
      writeClipboard: async () => {},
    });
    const dispose = mount({
      pluginId: "rail-folders",
      generation: 1,
      signal: new AbortController().signal,
    });
    await flush();

    expect(labels(hostMenu)).toEqual(["Настройки проекта", "Убрать"]);
    dispose();
  });

  it("ignores menus that are not a project menu", async () => {
    const hostMenu = menu(["Open", "Archive"], "thread-1 actions");
    const fetchItems = vi.fn(async () => [item({ path: "/work/a" })]);
    const mount = createProjectPathMenuMount({ fetchItems, writeClipboard: async () => {} });
    const dispose = mount({
      pluginId: "rail-folders",
      generation: 1,
      signal: new AbortController().signal,
    });
    await flush();

    expect(fetchItems).not.toHaveBeenCalled();
    expect(labels(hostMenu)).toEqual(["Open", "Archive"]);
    dispose();
  });

  it("survives host menu rebuilds without duplicating its items or refetching", async () => {
    const hostMenu = menu(["Настройки проекта", "Убрать"]);
    const fetchItems = vi.fn(async () => [item({ path: "/work/a" })]);
    const mount = createProjectPathMenuMount({
      fetchItems,
      writeClipboard: async () => {},
    });
    const dispose = mount({
      pluginId: "rail-folders",
      generation: 1,
      signal: new AbortController().signal,
    });
    await flush();

    hostMenu.setAttribute("data-host-update", "1");
    hostMenu.appendChild(document.createElement("div"));
    await flush();
    await flush();

    expect(labels(hostMenu).filter((text) => text === "Скопировать путь")).toHaveLength(1);
    expect(fetchItems).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("does not decorate a menu that already carries its items", async () => {
    const hostMenu = menu(["Настройки проекта", "Убрать"]);
    const existing = document.createElement("div");
    existing.setAttribute("role", "menuitem");
    existing.dataset.railFoldersAction = "copy";
    existing.textContent = "Скопировать путь";
    hostMenu.insertBefore(existing, hostMenu.lastElementChild);

    const fetchItems = vi.fn(async () => [item({ path: "/work/a" })]);
    const mount = createProjectPathMenuMount({
      fetchItems,
      writeClipboard: async () => {},
    });
    const dispose = mount({
      pluginId: "rail-folders",
      generation: 1,
      signal: new AbortController().signal,
    });
    await flush();

    expect(labels(hostMenu)).toEqual(["Настройки проекта", "Скопировать путь", "Убрать"]);
    dispose();
  });

  it("recognizes the host menu before the translation plugin renames its items", async () => {
    const hostMenu = menu(["Project settings", "Rename", "Remove"]);
    const mount = createProjectPathMenuMount({
      fetchItems: async () => [item({ path: "/work/a" })],
      writeClipboard: async () => {},
    });
    const dispose = mount({
      pluginId: "rail-folders",
      generation: 1,
      signal: new AbortController().signal,
    });
    await flush();

    expect(labels(hostMenu)).toEqual([
      "Project settings",
      "Rename",
      "Скопировать путь",
      "Remove",
    ]);
    dispose();
  });

  it("reuses the host separator styling when the menu already has one", async () => {
    const hostMenu = menu(["Настройки проекта", "Убрать"]);
    const hostSeparator = document.createElement("div");
    hostSeparator.setAttribute("role", "separator");
    hostSeparator.className = "bb-separator";
    hostMenu.insertBefore(hostSeparator, hostMenu.firstChild);
    const mount = createProjectPathMenuMount({
      fetchItems: async () => [item({ path: "/work/a" })],
      writeClipboard: async () => {},
    });
    const dispose = mount({
      pluginId: "rail-folders",
      generation: 1,
      signal: new AbortController().signal,
    });
    await flush();

    const separators = hostMenu.querySelectorAll<HTMLElement>('[role="separator"]');
    expect(separators).toHaveLength(2);
    expect(separators[1]!.className).toBe("bb-separator");
    dispose();
  });

  it("reads the project name from a Radix menu labelled by its trigger", async () => {
    const trigger = document.createElement("button");
    trigger.id = "radix-project-trigger";
    trigger.setAttribute("aria-label", "picker-routes actions");
    trigger.textContent = "";
    document.body.appendChild(trigger);

    const hostMenu = menu(["Настройки проекта", "Убрать"]);
    hostMenu.removeAttribute("aria-label");
    hostMenu.setAttribute("aria-labelledby", trigger.id);

    const fetchItems = vi.fn(async () => [item({ path: "/work/a" })]);
    const mount = createProjectPathMenuMount({
      fetchItems,
      writeClipboard: async () => {},
    });
    const dispose = mount({
      pluginId: "rail-folders",
      generation: 1,
      signal: new AbortController().signal,
    });
    await flush();

    expect(fetchItems).toHaveBeenCalledWith("picker-routes", expect.anything());
    expect(labels(hostMenu)).toEqual(["Настройки проекта", "Скопировать путь", "Убрать"]);
    dispose();
  });

  it("cleans up observers and pending work on dispose", async () => {
    const mount = createProjectPathMenuMount({
      fetchItems: async () => [item({ path: "/work/a" })],
      writeClipboard: async () => {},
    });
    const controller = new AbortController();
    const dispose = mount({
      pluginId: "rail-folders",
      generation: 1,
      signal: controller.signal,
    });
    await flush();
    dispose();
    controller.abort();

    const late = menu(["Настройки проекта", "Убрать"]);
    await flush();

    expect(labels(late)).toEqual(["Настройки проекта", "Убрать"]);
  });

  it("never throws into the host and keeps observing after a failure", async () => {
    const fetchItems = vi.fn(async () => {
      throw new Error("rpc down");
    });
    const mount = createProjectPathMenuMount({ fetchItems, writeClipboard: async () => {} });
    const dispose = mount({
      pluginId: "rail-folders",
      generation: 1,
      signal: new AbortController().signal,
    });
    await flush();
    const hostMenu = menu(["Настройки проекта", "Убрать"]);
    await flush();

    expect(labels(hostMenu)).toEqual(["Настройки проекта", "Убрать"]);
    dispose();
  });

  it("stops before injecting when the signal aborts during the fetch", async () => {
    const controller = new AbortController();
    let resolve!: (items: ProjectPathItem[]) => void;
    const mount = createProjectPathMenuMount({
      fetchItems: () => new Promise<ProjectPathItem[]>((done) => (resolve = done)),
      writeClipboard: async () => {},
    });
    const dispose = mount({
      pluginId: "rail-folders",
      generation: 1,
      signal: controller.signal,
    });
    const hostMenu = menu(["Настройки проекта", "Убрать"]);
    await flush();

    controller.abort();
    resolve([item({ path: "/work/a" })]);
    await flush();

    expect(labels(hostMenu)).toEqual(["Настройки проекта", "Убрать"]);
    dispose();
  });
});

describe("project path menu hover highlight", () => {
  function hostMenuWithHighlightClass(className = HOST_ITEM_CLASS): HTMLElement {
    return menu(["Настройки проекта", "Переименовать", "Убрать"], undefined, className);
  }

  async function mounted(hostMenu: HTMLElement) {
    const mount = createProjectPathMenuMount({
      fetchItems: async () => [
        item({ environmentName: "main", path: "/work/a" }),
        item({ environmentName: "feat", path: "/work/b" }),
      ],
      writeClipboard: async () => {},
    });
    const dispose = mount({
      pluginId: "rail-folders",
      generation: 1,
      signal: new AbortController().signal,
    });
    pendingDisposers.push(dispose);
    await flush();
    const copies = Array.from(
      hostMenu.querySelectorAll<HTMLElement>('[data-rail-folders-action="copy"]'),
    );
    return { hostMenu, dispose, copies };
  }

  function highlighted(menuElement: HTMLElement): HTMLElement[] {
    return Array.from(
      menuElement.querySelectorAll<HTMLElement>(`[${HIGHLIGHT_ATTRIBUTE}]`),
    );
  }

  function enter(element: HTMLElement): void {
    element.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false }));
  }

  function leave(element: HTMLElement): void {
    element.dispatchEvent(new PointerEvent("pointerleave", { bubbles: false }));
  }

  it("marks the hovered injected item and clears the host items", async () => {
    const { hostMenu, dispose, copies } = await mounted(hostMenuWithHighlightClass());
    const [first] = copies;

    enter(first!);

    expect(highlighted(hostMenu)).toEqual([first]);
    expect(first!.getAttribute(HIGHLIGHT_ATTRIBUTE)).toBe("");
    for (const hostItem of Array.from(
      hostMenu.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    )) {
      if (hostItem === first) continue;
      expect(hostItem.hasAttribute(HIGHLIGHT_ATTRIBUTE)).toBe(false);
    }
    expect(first!.getAttribute("tabindex")).toBe("-1");
    expect(first!.hasAttribute("data-disabled")).toBe(false);
    dispose();
  });

  it("steals the highlight from a host item that already carries it", async () => {
    const { hostMenu, dispose, copies } = await mounted(hostMenuWithHighlightClass());
    const hostItem = hostMenu.querySelector<HTMLElement>('[role="menuitem"]')!;
    hostItem.setAttribute(HIGHLIGHT_ATTRIBUTE, "");

    enter(copies[1]!);

    expect(highlighted(hostMenu)).toEqual([copies[1]]);
    dispose();
  });

  it("keeps the highlight after pointerleave until the next enter", async () => {
    const { hostMenu, dispose, copies } = await mounted(hostMenuWithHighlightClass());

    enter(copies[0]!);
    leave(copies[0]!);
    // The host keeps `last-hovered` on the row it left, so the injected row
    // must not clear it either.
    expect(highlighted(hostMenu)).toEqual([copies[0]]);

    enter(copies[1]!);
    expect(highlighted(hostMenu)).toEqual([copies[1]]);

    leave(copies[1]!);
    expect(highlighted(hostMenu)).toEqual([copies[1]]);
    dispose();
  });

  it("keeps a single highlight across repeated enters", async () => {
    const { hostMenu, dispose, copies } = await mounted(hostMenuWithHighlightClass());

    enter(copies[0]!);
    enter(copies[0]!);
    expect(highlighted(hostMenu)).toEqual([copies[0]]);

    enter(copies[1]!);
    expect(highlighted(hostMenu)).toEqual([copies[1]]);
    dispose();
  });

  it("drops highlights and nodes on dispose", async () => {
    const { hostMenu, dispose, copies } = await mounted(hostMenuWithHighlightClass());

    enter(copies[0]!);
    dispose();

    expect(document.querySelectorAll("[data-rail-folders-action]")).toHaveLength(0);
    expect(document.querySelectorAll(`[${HIGHLIGHT_ATTRIBUTE}]`)).toHaveLength(0);
    expect(hostMenu).not.toBe(null);
  });

  it("keys the highlight on the attribute the host classes actually use", async () => {
    const hostMenuElement = hostMenuWithHighlightClass(
      "bb-menu-item data-[highlighted]:bg-state-hover data-[highlighted]:text-foreground",
    );
    const { dispose, copies } = await mounted(hostMenuElement);

    enter(copies[0]!);

    expect(copies[0]!.getAttribute("data-highlighted")).toBe("");
    expect(highlighted(hostMenuElement)).toEqual([]);
    dispose();
  });

  it("ignores unrelated data attributes in the host classes", async () => {
    const hostMenuElement = hostMenuWithHighlightClass(
      "bb-menu-item data-[state=open]:bg-state-active data-[last-hovered]:bg-state-hover",
    );
    const { dispose, copies } = await mounted(hostMenuElement);

    enter(copies[0]!);

    expect(copies[0]!.getAttribute(HIGHLIGHT_ATTRIBUTE)).toBe("");
    expect(copies[0]!.hasAttribute("data-state")).toBe(false);
    dispose();
  });
});

describe("default rpc and clipboard", () => {
  it("posts to the plugin rpc endpoint and unwraps the result envelope", async () => {
    const fetchMock = vi.fn(async () =>
      response({
        ok: true,
        result: {
          items: [
            {
              projectId: "proj_1",
              projectName: "picker-routes",
              environmentName: "main",
              path: "/work/picker-routes",
            },
          ],
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const writeText = vi.fn(async () => {});
    setClipboard({ writeText });

    const hostMenu = menu(["Настройки проекта", "Убрать"]);
    const mount = createProjectPathMenuMount();
    const controller = new AbortController();
    const dispose = mount({
      pluginId: "rail-folders",
      generation: 1,
      signal: controller.signal,
    });
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/v1/plugins/rail-folders/rpc/project_paths");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ projectName: "picker-routes" });
    expect(init.signal).toBe(controller.signal);

    expect(labels(hostMenu)).toEqual(["Настройки проекта", "Скопировать путь", "Убрать"]);

    hostMenu.querySelector<HTMLElement>('[data-rail-folders-action="copy"]')!.click();
    await flush();
    expect(writeText).toHaveBeenCalledWith("/work/picker-routes");
    dispose();
  });

  it("leaves the menu alone when the rpc answers with an http error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        // A valid envelope behind a failed status proves the status check runs
        // before the payload is trusted.
        response(
          { ok: true, result: { items: [item({ path: "/work/a" })] } },
          500,
        ),
      ),
    );

    const hostMenu = menu(["Настройки проекта", "Убрать"]);
    const mount = createProjectPathMenuMount();
    const dispose = mount({
      pluginId: "rail-folders",
      generation: 1,
      signal: new AbortController().signal,
    });
    await flush();

    expect(labels(hostMenu)).toEqual(["Настройки проекта", "Убрать"]);
    dispose();
  });

  it("leaves the menu alone when the rpc payload fails validation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({ ok: true, result: { items: [{ path: "" }] } })),
    );

    const hostMenu = menu(["Настройки проекта", "Убрать"]);
    const mount = createProjectPathMenuMount();
    const dispose = mount({
      pluginId: "rail-folders",
      generation: 1,
      signal: new AbortController().signal,
    });
    await flush();

    expect(labels(hostMenu)).toEqual(["Настройки проекта", "Убрать"]);
    dispose();
  });

  it("reports a missing clipboard api instead of throwing", async () => {
    setClipboard(undefined);
    const keys: string[] = [];
    document.addEventListener("keydown", (event) => keys.push(event.key));

    const hostMenu = menu(["Настройки проекта", "Убрать"]);
    const mount = createProjectPathMenuMount({
      fetchItems: async () => [item({ path: "/work/a" })],
    });
    const dispose = mount({
      pluginId: "rail-folders",
      generation: 1,
      signal: new AbortController().signal,
    });
    await flush();

    const copy = hostMenu.querySelector<HTMLElement>('[data-rail-folders-action="copy"]')!;
    copy.click();
    await flush();

    expect(copy.textContent).toBe("Не удалось скопировать");
    expect(keys).toEqual([]);
    dispose();
  });
});
