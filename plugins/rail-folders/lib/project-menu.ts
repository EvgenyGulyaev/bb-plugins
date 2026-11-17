import type { PluginContentScriptContext } from "@get-bb/plugin-sdk/app";

import {
  dedupeProjectPaths,
  projectPathsOutputSchema,
  type ProjectPathItem,
} from "./project-paths";

// The host names each project's context menu "<project name> actions". Its
// items are localized, so the project menu is recognized by the aria-label
// plus the presence of the project settings entry.
const ACTIONS_SUFFIX = " actions";
// bb renders the project menu through its own labels; the Russian UI is
// usually delivered by a translation plugin, so both spellings count.
const PROJECT_SETTINGS_LABELS = new Set(["Project settings", "Настройки проекта"]);
const COPY_LABEL = "Скопировать путь";
const COPY_ALL_LABEL = "Скопировать все пути";
const COPY_FAILED_LABEL = "Не удалось скопировать";
const ACTION_DATA_ATTRIBUTE = "rail-folders-action";
// Hover is painted through a data attribute referenced by the host item
// classes, e.g. `data-[last-hovered]:bg-state-hover`. Radix renders rows in
// its own collection on its own; the rows injected here are outside it, so the
// host never marks them. The key is read back from those classes so a rename
// in bb keeps this working.
const HIGHLIGHT_ATTRIBUTE_PATTERN = /data-\[([a-z0-9-]+)\](?=:)/g;
// Radix and bb also hang structure and disabled styling off data attributes;
// those must not be mistaken for the hover key.
const NON_HOVER_ATTRIBUTES = new Set([
  "state",
  "orientation",
  "side",
  "align",
  "disabled",
  "open",
  "checked",
  "active",
]);
const FALLBACK_HIGHLIGHT_ATTRIBUTE = "data-last-hovered";
// bb drives hover with `last-hovered`; plain Radix items carry `highlighted`.
// Both may appear in the classes, so the bb key wins.
const HOVER_ATTRIBUTE_KEYS = ["last-hovered", "highlighted"] as const;

export interface ProjectMenuEntry {
  kind: "copy" | "copy-all";
  label: string;
  path: string | null;
}

export interface ProjectMenuModel {
  entries: ProjectMenuEntry[];
  copyAll: string | null;
}

export interface ProjectPathMenuDeps {
  fetchItems?: (projectName: string, signal: AbortSignal) => Promise<ProjectPathItem[]>;
  writeClipboard?: (text: string) => Promise<void>;
}

export function parseProjectMenuLabel(ariaLabel: string | null | undefined): string | null {
  if (typeof ariaLabel !== "string") return null;
  const trimmed = ariaLabel.trim();
  if (!trimmed.endsWith(ACTIONS_SUFFIX)) return null;
  const projectName = trimmed.slice(0, -ACTIONS_SUFFIX.length).trim();
  return projectName.length === 0 ? null : projectName;
}

function environmentLabel(item: ProjectPathItem): string {
  return item.environmentName ?? item.branchName ?? item.projectName;
}

export function buildProjectMenuModel(items: ProjectPathItem[]): ProjectMenuModel {
  const unique = dedupeProjectPaths(items);
  if (unique.length === 0) return { entries: [], copyAll: null };

  if (unique.length === 1) {
    return {
      entries: [{ kind: "copy", label: COPY_LABEL, path: unique[0]!.path }],
      copyAll: null,
    };
  }

  return {
    entries: [
      ...unique.map((item) => ({
        kind: "copy" as const,
        label: `${environmentLabel(item)}: ${item.path}`,
        path: item.path,
      })),
      { kind: "copy-all" as const, label: COPY_ALL_LABEL, path: null },
    ],
    copyAll: unique.map((item) => item.path).join("\n"),
  };
}

async function fetchProjectPaths(
  pluginId: string,
  projectName: string,
  signal: AbortSignal,
): Promise<ProjectPathItem[]> {
  const response = await fetch(
    `/api/v1/plugins/${encodeURIComponent(pluginId)}/rpc/project_paths`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectName }),
      signal,
    },
  );
  if (!response.ok) {
    throw new Error(`project_paths returned HTTP ${response.status}`);
  }
  const payload = (await response.json()) as { result?: unknown } | null;
  const parsed = projectPathsOutputSchema.safeParse(payload?.result);
  if (!parsed.success) throw new Error("project_paths returned an unexpected payload");
  return parsed.data.items;
}

async function writeClipboardText(text: string): Promise<void> {
  const clipboard = navigator.clipboard;
  if (clipboard === undefined || typeof clipboard.writeText !== "function") {
    throw new Error("clipboard unavailable");
  }
  await clipboard.writeText(text);
}

function hasProjectSettingsItem(menu: HTMLElement): boolean {
  return Array.from(menu.querySelectorAll('[role="menuitem"]')).some((item) =>
    PROJECT_SETTINGS_LABELS.has(item.textContent?.trim() ?? ""),
  );
}

function highlightAttribute(classes: string): string {
  const candidates = new Set<string>();
  for (const match of classes.matchAll(HIGHLIGHT_ATTRIBUTE_PATTERN)) {
    const key = match[1]!;
    if (!NON_HOVER_ATTRIBUTES.has(key)) candidates.add(key);
  }
  for (const key of HOVER_ATTRIBUTE_KEYS) {
    if (candidates.delete(key)) return `data-${key}`;
  }
  const [first] = candidates;
  return first === undefined ? FALLBACK_HIGHLIGHT_ATTRIBUTE : `data-${first}`;
}

// Radix labels a portalled menu through aria-labelledby, pointing at its
// trigger — the "…" button whose aria-label is "<project name> actions".
// The visible menu rarely carries an aria-label of its own.
function menuAccessibleLabel(menu: HTMLElement): string | null {
  const label = menu.getAttribute("aria-label");
  if (label !== null && label.trim().length > 0) return label;
  const labelledBy = menu.getAttribute("aria-labelledby");
  if (labelledBy === null) return null;
  const parts = labelledBy
    .split(/\s+/)
    .map((id) => document.getElementById(id))
    .filter((element): element is HTMLElement => element !== null)
    .map(
      (element) =>
        element.getAttribute("aria-label")?.trim() ||
        element.textContent?.trim() ||
        "",
    )
    .filter((text) => text.length > 0);
  return parts.length === 0 ? null : parts.join(" ");
}

export function createProjectPathMenuMount(deps: ProjectPathMenuDeps = {}) {
  return (context: PluginContentScriptContext): (() => void) => {
    const loadItems =
      deps.fetchItems ??
      ((projectName: string, signal: AbortSignal) =>
        fetchProjectPaths(context.pluginId, projectName, signal));
    const writeClipboard = deps.writeClipboard ?? writeClipboardText;

    const injected = new Set<HTMLElement>();
    const handledMenus = new WeakSet<HTMLElement>();
    let disposed = false;

    const isLive = () => !disposed && !context.signal.aborted;

    async function copyText(
      text: string,
      item: HTMLElement,
      label: HTMLElement,
    ): Promise<void> {
      try {
        await writeClipboard(text);
        if (!isLive()) return;
        // Radix menus listen for Escape on the document; dispatching it here
        // closes the host's menu exactly like the keyboard would.
        document.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
      } catch {
        if (!isLive() || !item.isConnected) return;
        label.textContent = COPY_FAILED_LABEL;
        item.removeAttribute("title");
      }
    }

    function inject(menu: HTMLElement, model: ProjectMenuModel): void {
      if (model.entries.length === 0) return;
      if (menu.querySelector(`[data-${ACTION_DATA_ATTRIBUTE}]`)) {
        return;
      }

      const hostItems = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'));
      const anchor = hostItems.at(-1) ?? null;
      const className = hostItems[0]?.className ?? "";
      const highlight = highlightAttribute(className);
      const nodes: HTMLElement[] = [];

      const hostSeparator = menu.querySelector<HTMLElement>('[role="separator"]');
      const separator = document.createElement("div");
      separator.setAttribute("role", "separator");
      separator.setAttribute("aria-hidden", "true");
      if (hostSeparator !== null) {
        separator.className = hostSeparator.className;
      } else {
        separator.style.cssText =
          "margin:4px 0;height:1px;min-height:1px;background:currentColor;opacity:0.15;pointer-events:none";
      }
      nodes.push(separator);

      for (const entry of model.entries) {
        const item = document.createElement("div");
        item.setAttribute("role", "menuitem");
        item.setAttribute("tabindex", "-1");
        item.className = className;
        item.style.overflow = "hidden";
        item.dataset.railFoldersAction = entry.kind;

        const label = document.createElement("span");
        label.textContent = entry.label;
        label.style.cssText =
          "display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:420px";
        item.appendChild(label);

        const path = entry.kind === "copy-all" ? model.copyAll : entry.path;
        if (path !== null) {
          item.title = path;
          item.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            void copyText(path, item, label);
          });
        }
        // The injected rows sit outside Radix's item collection, so only a bare
        // pointerenter reaches them; the highlight is moved by hand to whoever
        // is hovered, exactly like the host's own rows behave.
        item.addEventListener("pointerenter", () => {
          if (!isLive()) return;
          menu.querySelectorAll<HTMLElement>('[role="menuitem"]').forEach((other) => {
            if (other !== item) other.removeAttribute(highlight);
          });
          item.setAttribute(highlight, "");
        });
        item.addEventListener("pointerleave", () => {
          item.removeAttribute(highlight);
        });
        nodes.push(item);
      }

      for (const node of nodes) {
        if (anchor === null) menu.appendChild(node);
        else menu.insertBefore(node, anchor);
        injected.add(node);
      }
    }

    function enhance(): void {
      if (!isLive()) return;
      // Closed menus take their subtree with them; dropping the detached
      // nodes keeps this set from growing over a long session.
      for (const node of injected) {
        if (!node.isConnected) injected.delete(node);
      }
      const menus = Array.from(document.querySelectorAll<HTMLElement>('[role="menu"]'));
      for (const menu of menus) {
        if (handledMenus.has(menu)) continue;
        const projectName = parseProjectMenuLabel(menuAccessibleLabel(menu));
        if (projectName === null || !hasProjectSettingsItem(menu)) continue;
        handledMenus.add(menu);
        void loadItems(projectName, context.signal)
          .then((items) => {
            if (!isLive() || !menu.isConnected) return;
            inject(menu, buildProjectMenuModel(items));
          })
          .catch(() => {
            // A failed lookup leaves the host menu exactly as bb rendered it.
          });
      }
    }

    const observer = new MutationObserver(() => {
      try {
        enhance();
      } catch {
        // Never let a decoration failure break the host's menu.
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    try {
      enhance();
    } catch {
      // The initial scan is best effort for the same reason.
    }

    return () => {
      disposed = true;
      observer.disconnect();
      for (const node of injected) node.remove();
      injected.clear();
    };
  };
}

export const mountProjectPathMenu = createProjectPathMenuMount();
