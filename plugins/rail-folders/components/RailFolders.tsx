import { useMemo, useState } from "react";
import {
  experimental_SidebarNavigationIcon,
  experimental_useSidebarNavigation,
  experimental_useSidebarNavigationSplit,
} from "@get-bb/plugin-sdk/app";
import type {
  ExperimentalSidebarNavigationActions,
  ExperimentalSidebarNavigationItem,
} from "@get-bb/plugin-sdk/app";

import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Icon } from "@/components/ui/icon";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useRailFolders } from "@/hooks/useRailFolders";
import {
  DEFAULT_FOLDER_ICON,
  folderMembers,
  layoutRail,
  type Folder,
} from "@/lib/folders";
import { cn } from "@/lib/utils";

import { DeleteFolderDialog, RenameFolderDialog } from "./FolderDialogs";
import { ItemContextMenu, type ItemMenuActions } from "./ItemContextMenu";
import { RailMenuRow, railItemLabel, targetForClick } from "./RailMenuRow";

const RAIL_BUTTON_CLASS =
  "relative size-8 shrink-0 rounded-md aria-[current=page]:bg-state-active aria-[current=page]:text-foreground";

// The SDK exports the icon component under a lowercase experimental_ name,
// which JSX would read as an intrinsic element, so it needs an alias.
const SidebarNavigationIcon = experimental_SidebarNavigationIcon;

function folderFromLabel(label: string): string {
  const trimmed = label.trim();
  return trimmed === "" ? "Папка" : trimmed.slice(0, 60);
}

function HomeButton() {
  const { isHomeActive, actions } = experimental_useSidebarNavigation();
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label="Домой"
      aria-current={isHomeActive ? "page" : undefined}
      data-rail-entry="home"
      onClick={(event) =>
        actions.goHome({ target: event.metaKey || event.ctrlKey ? "tab" : "current" })
      }
      className={RAIL_BUTTON_CLASS}
    >
      <Icon name="House" fallback="Home" className="size-4" aria-hidden="true" />
    </Button>
  );
}

function MoreItemsButton({
  items,
  activeItemId,
  showShortcut,
  menu,
}: {
  items: readonly ExperimentalSidebarNavigationItem[];
  activeItemId: string | null;
  showShortcut: boolean;
  menu: ItemMenuActions;
}) {
  const { actions } = experimental_useSidebarNavigation();
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Ещё"
          aria-haspopup="menu"
          className={RAIL_BUTTON_CLASS}
        >
          <Icon
            name="MoreHorizontal"
            fallback="MoreHorizontal"
            className="size-4"
            aria-hidden="true"
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={8}
        aria-label="Скрытые иконки"
        className="w-64 p-1"
      >
        <div role="menu" aria-label="Скрытые иконки" className="flex flex-col">
          {items.map((item) => (
            <RailMenuRow
              key={item.id}
              item={item}
              isActive={item.id === activeItemId}
              showShortcut={showShortcut}
              menu={menu}
              onActivate={(activated, target) => {
                setOpen(false);
                actions.activate(activated.id, { target });
              }}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function FolderButton({
  folder,
  members,
  activeItemId,
  showShortcut,
  actions,
  menu,
  onRename,
  onDelete,
}: {
  folder: Folder;
  members: readonly ExperimentalSidebarNavigationItem[];
  activeItemId: string | null;
  showShortcut: boolean;
  actions: ExperimentalSidebarNavigationActions;
  menu: ItemMenuActions;
  onRename: (folder: Folder) => void;
  onDelete: (folder: Folder) => void;
}) {
  const [open, setOpen] = useState(false);
  const hasBadge = members.some((member) => member.badge !== null);
  const isActive = members.some((member) => member.id === activeItemId);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={folder.name}
              aria-current={isActive ? "page" : undefined}
              aria-haspopup="menu"
              data-rail-entry={`folder:${folder.id}`}
              className={RAIL_BUTTON_CLASS}
            >
              <Icon
                name={folder.icon}
                fallback={DEFAULT_FOLDER_ICON}
                className="size-4"
                aria-hidden="true"
              />
              {hasBadge ? (
                <span
                  data-rail-badge-dot=""
                  aria-hidden="true"
                  className="absolute right-1 top-1 size-1.5 rounded-full bg-primary"
                />
              ) : null}
            </Button>
          </PopoverTrigger>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuLabel className="truncate">
            {folder.name}
          </ContextMenuLabel>
          <ContextMenuItem onSelect={() => onRename(folder)}>
            <Icon name="Pencil" className="size-4" aria-hidden="true" />
            Переименовать папку
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => onDelete(folder)}>
            <Icon name="Trash2" className="size-4" aria-hidden="true" />
            Удалить папку
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={8}
        aria-label={folder.name}
        className="w-64 p-1"
      >
        <div role="menu" aria-label={folder.name} className="flex flex-col">
          {members.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              В папке пусто
            </p>
          ) : (
            members.map((item) => (
              <RailMenuRow
                key={item.id}
                item={item}
                isActive={item.id === activeItemId}
                showShortcut={showShortcut}
                menu={menu}
                onActivate={(activated, target) => {
                  setOpen(false);
                  actions.activate(activated.id, { target });
                }}
              />
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function RailItemButton({
  item,
  isActive,
  showShortcut,
  actions,
  menu,
}: {
  item: ExperimentalSidebarNavigationItem;
  isActive: boolean;
  showShortcut: boolean;
  actions: ExperimentalSidebarNavigationActions;
  menu: ItemMenuActions;
}) {
  const split = experimental_useSidebarNavigationSplit(item.id);
  const unavailable = item.isDisabled || item.isLoading;
  const label = railItemLabel(item);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={label}
          aria-keyshortcuts={item.shortcut?.ariaKeyShortcuts}
          aria-current={isActive ? "page" : undefined}
          disabled={unavailable}
          data-rail-entry={`item:${item.id}`}
          {...split.splitProps}
          onClick={(event) => {
            if (unavailable) return;
            actions.activate(item.id, { target: targetForClick(event) });
          }}
          className={RAIL_BUTTON_CLASS}
        >
          <SidebarNavigationIcon icon={item.icon} className="size-4" />
          {showShortcut && item.shortcut !== null ? (
            <kbd
              data-rail-shortcut=""
              className="pointer-events-none absolute -bottom-0.5 left-1/2 -translate-x-1/2 rounded bg-background px-0.5 text-[9px] leading-3 text-muted-foreground"
            >
              {item.shortcut.label}
            </kbd>
          ) : null}
        </Button>
      </ContextMenuTrigger>
      <ItemContextMenu item={item} actions={actions} menu={menu} />
    </ContextMenu>
  );
}

/**
 * The whole left rail: Home, the folders and ungrouped icons of the user's
 * arrangement, and an overflow menu for items the user hid. bb draws Settings
 * below this column itself.
 */
export function RailFolders() {
  const { items, activeItemId, isShortcutModifierHeld, actions } =
    experimental_useSidebarNavigation();
  const { state, error, mutate } = useRailFolders();
  const [renameTarget, setRenameTarget] = useState<Folder | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Folder | null>(null);

  const itemsById = useMemo(
    () => new Map(items.map((item) => [item.id, item])),
    [items],
  );
  const entries = useMemo(() => layoutRail(state, items), [state, items]);
  const hiddenItems = useMemo(
    () => items.filter((item) => !item.isVisible),
    [items],
  );
  const knownItemIds = useMemo(
    () => new Set(items.map((item) => item.id)),
    [items],
  );

  const createFolderFor = (item: ExperimentalSidebarNavigationItem) => {
    void mutate("folders_create", {
      name: folderFromLabel(item.label),
      icon: DEFAULT_FOLDER_ICON,
      itemIds: [item.id],
    });
  };
  const addToFolder = (
    item: ExperimentalSidebarNavigationItem,
    folderId: string,
  ) => {
    void mutate("folders_add_item", { folderId, itemId: item.id });
  };
  const removeFromFolder = (item: ExperimentalSidebarNavigationItem) => {
    void mutate("folders_remove_item", { itemId: item.id });
  };

  const menu: ItemMenuActions = {
    folders: state.folders,
    onCreateFolder: createFolderFor,
    onAddToFolder: addToFolder,
    onRemoveFromFolder: removeFromFolder,
  };

  return (
    <>
      <nav
        aria-label="Папки рейла"
        className={cn(
          "flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto px-1 py-2",
        )}
      >
        <HomeButton />
        <div aria-hidden="true" className="my-1 h-px w-6 shrink-0 bg-border" />
        {entries.map((entry) =>
          entry.kind === "folder" ? (
            <FolderButton
              key={`folder:${entry.folder.id}`}
              folder={entry.folder}
              members={folderMembers(entry.folder, knownItemIds)
                .map((itemId) => itemsById.get(itemId))
                .filter(
                  (item): item is ExperimentalSidebarNavigationItem =>
                    item !== undefined,
                )}
              activeItemId={activeItemId}
              showShortcut={isShortcutModifierHeld}
              actions={actions}
              menu={menu}
              onRename={setRenameTarget}
              onDelete={setDeleteTarget}
            />
          ) : (
            <RailItemButton
              key={entry.itemId}
              item={itemsById.get(entry.itemId)!}
              isActive={entry.itemId === activeItemId}
              showShortcut={isShortcutModifierHeld}
              actions={actions}
              menu={menu}
            />
          ),
        )}
        {hiddenItems.length === 0 ? null : (
          <MoreItemsButton
            items={hiddenItems}
            activeItemId={activeItemId}
            showShortcut={isShortcutModifierHeld}
            menu={menu}
          />
        )}
        {error === null ? null : (
          <p
            role="alert"
            className="w-full px-1 pb-1 text-center text-[10px] leading-tight text-destructive"
          >
            {error}
          </p>
        )}
      </nav>
      <RenameFolderDialog
        folder={renameTarget}
        onClose={() => setRenameTarget(null)}
        onSubmit={(name) => {
          if (renameTarget !== null) {
            void mutate("folders_rename", { id: renameTarget.id, name });
          }
        }}
      />
      <DeleteFolderDialog
        folder={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget !== null) {
            void mutate("folders_delete", { id: deleteTarget.id });
          }
        }}
      />
    </>
  );
}
