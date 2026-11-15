import { useMemo, useState } from "react";
import type { DragEvent } from "react";
import {
  experimental_SidebarNavigationIcon,
  experimental_useSidebarNavigation,
  experimental_useSidebarNavigationSplit,
} from "@get-bb/plugin-sdk/app";
import type {
  ExperimentalSidebarNavigationActions,
  ExperimentalSidebarNavigationItem,
} from "@get-bb/plugin-sdk/app";

import { buttonVariants } from "@/components/ui/button";
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
  RAIL_FOLDER_DRAG_MIME,
  RAIL_ITEM_DRAG_MIME,
  RAIL_MEMBER_DRAG_MIME,
  applyVisibleOrder,
  folderById,
  folderMembers,
  folderOfItem,
  layoutRail,
  placeInOrder,
  railSequence,
  type Folder,
  type InsertionSide,
  type RailFoldersState,
} from "@/lib/folders";
import { cn } from "@/lib/utils";

import {
  CreateFolderDialog,
  DeleteFolderDialog,
  RenameFolderDialog,
} from "./FolderDialogs";
import { ItemContextMenu, type ItemMenuActions } from "./ItemContextMenu";
import { RailCustomizeDialog } from "./RailCustomizeDialog";
import {
  RailMenuRow,
  dropSideFor,
  railItemLabel,
  targetForClick,
} from "./RailMenuRow";

const RAIL_BUTTON_CLASS =
  "relative size-8 shrink-0 rounded-md data-[active]:bg-state-active data-[active]:text-foreground";

/** Whether a drag carries one of our item ids. */
function carriesRailItem(dataTransfer: DataTransfer): boolean {
  return dataTransfer.types.includes(RAIL_ITEM_DRAG_MIME);
}

/** Whether a drag carries one of our folder ids. */
function carriesRailFolder(dataTransfer: DataTransfer): boolean {
  return dataTransfer.types.includes(RAIL_FOLDER_DRAG_MIME);
}

/** Whether a drag started from a row inside a folder. */
function carriesFolderMember(dataTransfer: DataTransfer): boolean {
  return dataTransfer.types.includes(RAIL_MEMBER_DRAG_MIME);
}

// The SDK exports the icon component under a lowercase experimental_ name,
// which JSX would read as an intrinsic element, so it needs an alias.
const SidebarNavigationIcon = experimental_SidebarNavigationIcon;

function HomeButton() {
  const { isHomeActive, actions } = experimental_useSidebarNavigation();
  return (
    <button
      type="button"
      aria-label="Домой"
      aria-current={isHomeActive ? "page" : undefined}
      data-active={isHomeActive ? "" : undefined}
      data-rail-entry="home"
      onClick={(event) =>
        actions.goHome({
          target: event.metaKey || event.ctrlKey ? "tab" : "current",
        })
      }
      className={cn(
        buttonVariants({ variant: "ghost", size: "icon" }),
        RAIL_BUTTON_CLASS,
      )}
    >
      <Icon name="House" fallback="Home" className="size-4" aria-hidden="true" />
    </button>
  );
}

function MoreItemsButton({
  items,
  activeItemId,
  showShortcut,
  menu,
  onCustomize,
}: {
  items: readonly ExperimentalSidebarNavigationItem[];
  activeItemId: string | null;
  showShortcut: boolean;
  menu: ItemMenuActions;
  onCustomize: () => void;
}) {
  const { actions } = experimental_useSidebarNavigation();
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Ещё"
          className={cn(
            buttonVariants({ variant: "ghost", size: "icon" }),
            RAIL_BUTTON_CLASS,
          )}
        >
          <Icon
            name="MoreHorizontal"
            fallback="MoreHorizontal"
            className="size-4"
            aria-hidden="true"
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={8}
        aria-label="Ещё"
        className="w-64 p-1"
      >
        {items.length === 0 ? null : (
          <div role="group" aria-label="Скрытые иконки" className="flex flex-col">
            {items.map((item) => (
              <RailMenuRow
                key={item.id}
                item={item}
                isActive={item.id === activeItemId}
                showShortcut={showShortcut}
                menu={menu}
                onClose={() => setOpen(false)}
                onActivate={(activated, target) => {
                  setOpen(false);
                  actions.activate(activated.id, { target });
                }}
              />
            ))}
          </div>
        )}
        <div aria-hidden="true" className="my-1 h-px bg-border" />
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            setOpen(false);
            onCustomize();
          }}
          className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs outline-none hover:bg-state-hover focus-visible:bg-state-hover"
        >
          <Icon
            name="SlidersHorizontal"
            fallback="Settings2"
            className="size-4 shrink-0"
            aria-hidden="true"
          />
          Настроить рейл…
        </button>
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
  onDropItem,
  onPlaceFolder,
  onReorderItems,
}: {
  folder: Folder;
  members: readonly ExperimentalSidebarNavigationItem[];
  activeItemId: string | null;
  showShortcut: boolean;
  actions: ExperimentalSidebarNavigationActions;
  menu: ItemMenuActions;
  onRename: (folder: Folder) => void;
  onDelete: (folder: Folder) => void;
  onDropItem: (folderId: string, itemId: string) => void;
  onPlaceFolder: (
    draggedFolderId: string,
    targetId: string | null,
    side: InsertionSide,
  ) => void;
  onReorderItems: (folderId: string, itemIds: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [folderDrop, setFolderDrop] = useState<InsertionSide | null>(null);
  const [dragging, setDragging] = useState(false);
  const badgeLabels = members.flatMap((member) =>
    member.badge === null ? [] : [member.badge.label],
  );
  const hasBadge = badgeLabels.length > 0;
  const isActive = members.some((member) => member.id === activeItemId);
  // The dot is decorative, so the badges it stands for join the folder's name.
  const label = hasBadge
    ? `${folder.name}, ${badgeLabels.join(", ")}`
    : folder.name;

  const visibleIds = members.map((member) => member.id);
  const clearDrop = () => {
    setDropActive(false);
    setFolderDrop(null);
  };
  // Members the host still publishes move through this popover; stale ids keep
  // their slots so the permutation sent to the server is always complete.
  const reorderMember = (
    draggedId: string,
    targetId: string,
    side: InsertionSide,
  ) => {
    if (draggedId === targetId || !folder.itemIds.includes(draggedId)) return;
    const from = visibleIds.indexOf(draggedId);
    const target = visibleIds.indexOf(targetId);
    if (from < 0 || target < 0) return;

    let index = target + (side === "after" ? 1 : 0);
    if (from < index) index -= 1;
    const next = visibleIds.filter((itemId) => itemId !== draggedId);
    next.splice(Math.max(0, Math.min(index, next.length)), 0, draggedId);
    onReorderItems(
      folder.id,
      applyVisibleOrder(folder.itemIds, visibleIds, next),
    );
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div
        draggable
        data-rail-folder-drag={folder.id}
        data-rail-dragging={dragging ? "" : undefined}
        onDragStart={(event: DragEvent<HTMLDivElement>) => {
          event.stopPropagation();
          event.dataTransfer.setData(RAIL_FOLDER_DRAG_MIME, folder.id);
          event.dataTransfer.effectAllowed = "move";
          setDragging(true);
        }}
        onDragEnd={() => {
          setDragging(false);
          clearDrop();
        }}
        className={cn(
          "relative shrink-0 rounded-md transition",
          dragging && "opacity-40",
        )}
      >
        {folderDrop === null ? null : (
          <span
            data-folder-drop-line={folderDrop}
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute inset-x-0 z-10 h-0.5 rounded-full bg-primary",
              folderDrop === "before" ? "-top-px" : "-bottom-px",
            )}
          />
        )}
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={label}
                title={folder.name}
                aria-current={isActive ? "true" : undefined}
                data-active={isActive ? "" : undefined}
                data-rail-entry={`folder:${folder.id}`}
                data-drop-active={dropActive ? "" : undefined}
                onDragOver={(event) => {
                  if (carriesRailFolder(event.dataTransfer)) {
                    event.preventDefault();
                    event.stopPropagation();
                    event.dataTransfer.dropEffect = "move";
                    setDropActive(false);
                    setFolderDrop(dropSideFor(event));
                    return;
                  }
                  if (!carriesRailItem(event.dataTransfer)) return;
                  event.preventDefault();
                  event.stopPropagation();
                  event.dataTransfer.dropEffect = "move";
                  setDropActive(true);
                  setFolderDrop(null);
                }}
                onDragLeave={(event) => {
                  event.stopPropagation();
                  // Moving between the button and its icon fires a dragleave on
                  // the button; only a real exit clears the highlight.
                  if (
                    event.currentTarget.contains(
                      event.relatedTarget as Node | null,
                    )
                  ) {
                    return;
                  }
                  clearDrop();
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  const side = folderDrop ?? dropSideFor(event);
                  const draggedFolderId =
                    event.dataTransfer.getData(RAIL_FOLDER_DRAG_MIME);
                  clearDrop();
                  if (draggedFolderId !== "") {
                    onPlaceFolder(draggedFolderId, folder.id, side);
                    return;
                  }
                  const itemId = event.dataTransfer.getData(
                    RAIL_ITEM_DRAG_MIME,
                  );
                  if (itemId !== "") onDropItem(folder.id, itemId);
                }}
                className={cn(
                  buttonVariants({ variant: "ghost", size: "icon" }),
                  RAIL_BUTTON_CLASS,
                  "transition",
                  dropActive && "scale-110 ring-2 ring-ring",
                )}
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
              </button>
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
      </div>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={8}
        aria-label={folder.name}
        className="w-64 p-1"
      >
        <p className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
          {folder.name}
        </p>
        <div role="group" aria-label={folder.name} className="flex flex-col">
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
                onClose={() => setOpen(false)}
                onActivate={(activated, target) => {
                  setOpen(false);
                  actions.activate(activated.id, { target });
                }}
                onReorderDrop={(draggedId, side) =>
                  reorderMember(draggedId, item.id, side)
                }
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
  onPlaceFolder,
}: {
  item: ExperimentalSidebarNavigationItem;
  isActive: boolean;
  showShortcut: boolean;
  actions: ExperimentalSidebarNavigationActions;
  menu: ItemMenuActions;
  onPlaceFolder: (
    draggedFolderId: string,
    targetId: string | null,
    side: InsertionSide,
  ) => void;
}) {
  const split = experimental_useSidebarNavigationSplit(item.id);
  const [dragging, setDragging] = useState(false);
  const [folderDrop, setFolderDrop] = useState<InsertionSide | null>(null);
  const unavailable = item.isDisabled || item.isLoading;
  const label = railItemLabel(item);

  return (
    // The wrapper owns the native drag so the button keeps the split gesture.
    // It is also a drop target for a folder, which then lands before or after
    // this single icon.
    <div
      draggable
      data-rail-entry={`item:${item.id}`}
      data-rail-dragging={dragging ? "" : undefined}
      onDragStart={(event: DragEvent<HTMLDivElement>) => {
        event.dataTransfer.setData(RAIL_ITEM_DRAG_MIME, item.id);
        event.dataTransfer.effectAllowed = "move";
        setDragging(true);
      }}
      onDragEnd={() => {
        setDragging(false);
        setFolderDrop(null);
      }}
      onDragOver={(event) => {
        if (!carriesRailFolder(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        setFolderDrop(dropSideFor(event));
      }}
      onDragLeave={(event) => {
        if (!carriesRailFolder(event.dataTransfer)) return;
        event.stopPropagation();
        if (
          event.currentTarget.contains(event.relatedTarget as Node | null)
        ) {
          return;
        }
        setFolderDrop(null);
      }}
      onDrop={(event) => {
        if (!carriesRailFolder(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        const side = folderDrop ?? dropSideFor(event);
        const draggedFolderId =
          event.dataTransfer.getData(RAIL_FOLDER_DRAG_MIME);
        setFolderDrop(null);
        if (draggedFolderId !== "") {
          onPlaceFolder(draggedFolderId, item.id, side);
        }
      }}
      className={cn(
        "relative shrink-0 rounded-md transition",
        dragging && "opacity-40",
      )}
    >
      {folderDrop === null ? null : (
        <span
          data-folder-drop-line={folderDrop}
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-x-0 z-10 h-0.5 rounded-full bg-primary",
            folderDrop === "before" ? "-top-px" : "-bottom-px",
          )}
        />
      )}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            aria-label={label}
            aria-keyshortcuts={item.shortcut?.ariaKeyShortcuts}
            aria-current={isActive ? "page" : undefined}
            disabled={unavailable}
            data-active={isActive ? "" : undefined}
            {...split.splitProps}
            onClick={(event) => {
              if (unavailable) return;
              actions.activate(item.id, { target: targetForClick(event) });
            }}
            className={cn(
              buttonVariants({ variant: "ghost", size: "icon" }),
              RAIL_BUTTON_CLASS,
            )}
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
          </button>
        </ContextMenuTrigger>
        <ItemContextMenu item={item} actions={actions} menu={menu} />
      </ContextMenu>
    </div>
  );
}

/**
 * The whole left rail: Home, the folders and ungrouped icons of the user's
 * arrangement, and an overflow menu for items the user hid plus the rail
 * editor. bb draws Settings below this column itself.
 */
export function RailFolders() {
  const { items, activeItemId, isShortcutModifierHeld, actions } =
    experimental_useSidebarNavigation();
  const { state, isLoaded, error, mutate } = useRailFolders();
  const [renameTarget, setRenameTarget] = useState<Folder | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Folder | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [dropActive, setDropActive] = useState(false);

  const itemsById = useMemo(
    () => new Map(items.map((item) => [item.id, item])),
    [items],
  );
  const entries = useMemo(() => layoutRail(state, items), [state, items]);
  const hiddenItems = useMemo(
    () =>
      items.filter(
        (item) =>
          !item.isVisible && folderOfItem(state, item.id) === null,
      ),
    [items, state],
  );
  const knownItemIds = useMemo(
    () => new Set(items.map((item) => item.id)),
    [items],
  );

  const addToFolder = (folderId: string, itemId: string) => {
    void mutate("folders_add_item", { folderId, itemId });
  };
  const removeFromFolder = (item: ExperimentalSidebarNavigationItem) => {
    void mutate("folders_remove_item", { itemId: item.id });
  };
  const reorderItems = (folderId: string, itemIds: string[]) => {
    void mutate("folders_reorder_items", { id: folderId, itemIds });
  };
  // A folder lands where the pointer is: before or after the hovered folder or
  // single icon, or at the end of the whole rail for a drop on free space. The
  // frontend materializes the drawn sequence and sends it as one new order.
  const placeFolder = (
    draggedFolderId: string,
    targetId: string | null,
    side: InsertionSide,
  ) => {
    const sequence = railSequence(state, items);
    const target = targetId === null ? -1 : sequence.indexOf(targetId);
    if (targetId !== null && target < 0) return;
    const beforeId =
      targetId === null
        ? null
        : side === "after"
          ? sequence[target + 1] ?? null
          : targetId;

    const materialized: RailFoldersState = {
      folders: state.folders,
      order: sequence,
    };
    const next = placeInOrder(materialized, items, draggedFolderId, beforeId);
    if (next === materialized) return;
    void mutate("rail_set_order", { order: next.order });
  };

  const menu: ItemMenuActions = {
    folders: state.folders,
    onNewFolder: () => setCreateOpen(true),
    onAddToFolder: (item, folderId) => addToFolder(folderId, item.id),
    onRemoveFromFolder: removeFromFolder,
  };

  return (
    <>
      <nav
        aria-label="Папки рейла"
        className="flex min-h-0 w-full flex-1 flex-col items-center"
      >
        <div
          data-rail-dropzone=""
          data-drop-active={dropActive ? "" : undefined}
          onDragOver={(event) => {
            if (
              !carriesRailFolder(event.dataTransfer) &&
              !carriesFolderMember(event.dataTransfer)
            ) {
              return;
            }
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            setDropActive(true);
          }}
          onDragLeave={(event) => {
            if (
              event.currentTarget.contains(event.relatedTarget as Node | null)
            ) {
              return;
            }
            setDropActive(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            setDropActive(false);
            const folderId = event.dataTransfer.getData(RAIL_FOLDER_DRAG_MIME);
            // A folder dropped on the free rail goes to the end of the whole
            // order; an icon row dropped there leaves its folder.
            if (folderId !== "" && folderById(state, folderId) !== null) {
              placeFolder(folderId, null, "after");
              return;
            }
            const itemId = event.dataTransfer.getData(RAIL_ITEM_DRAG_MIME);
            // Only an icon that came out of a folder can return to the rail.
            if (
              itemId === "" ||
              !carriesFolderMember(event.dataTransfer) ||
              folderOfItem(state, itemId) === null
            ) {
              return;
            }
            void mutate("folders_remove_item", { itemId });
          }}
          className={cn(
            "flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto px-1 py-2 transition",
            dropActive && "rounded-md bg-state-active",
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
                onDropItem={addToFolder}
                onPlaceFolder={placeFolder}
                onReorderItems={reorderItems}
              />
            ) : (
              <RailItemButton
                key={entry.itemId}
                item={itemsById.get(entry.itemId)!}
                isActive={entry.itemId === activeItemId}
                showShortcut={isShortcutModifierHeld}
                actions={actions}
                menu={menu}
                onPlaceFolder={placeFolder}
              />
            ),
          )}
          <MoreItemsButton
            items={hiddenItems}
            activeItemId={activeItemId}
            showShortcut={isShortcutModifierHeld}
            menu={menu}
            onCustomize={() => setCustomizeOpen(true)}
          />
          {error === null ? null : (
            <p
              role="alert"
              className="w-full px-1 pb-1 text-center text-[10px] leading-tight text-destructive"
            >
              {error}
            </p>
          )}
        </div>
      </nav>
      <CreateFolderDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreate={(input) => {
          void mutate("folders_create", input);
        }}
      />
      <RenameFolderDialog
        folder={renameTarget}
        onClose={() => setRenameTarget(null)}
        onSubmit={(name, icon) => {
          if (renameTarget === null) return;
          const target = renameTarget;
          void mutate("folders_rename", { id: target.id, name });
          if (icon !== target.icon) {
            void mutate("folders_set_icon", { id: target.id, icon });
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
      <RailCustomizeDialog
        open={customizeOpen}
        onClose={() => setCustomizeOpen(false)}
        state={state}
        isLoaded={isLoaded}
        items={items}
        actions={actions}
        onMoveFolder={(folder, direction) => {
          void mutate("folders_move", { id: folder.id, direction });
        }}
        onRenameFolder={setRenameTarget}
        onDeleteFolder={setDeleteTarget}
        onSetOrder={(order) => {
          void mutate("rail_set_order", { order });
        }}
        onSetVisible={(itemId, isVisible) => {
          actions.setVisible(itemId, isVisible);
        }}
      />
    </>
  );
}
