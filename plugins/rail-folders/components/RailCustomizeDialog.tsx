import {
  experimental_SidebarNavigationIcon,
  type ExperimentalSidebarNavigationActions,
  type ExperimentalSidebarNavigationItem,
} from "@get-bb/plugin-sdk/app";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import {
  DEFAULT_FOLDER_ICON,
  moveFolder,
  moveItemInOrder,
  orderedFolders,
  railEditableSequence,
  singleIconIds,
  type Folder,
  type FolderMoveDirection,
  type RailFoldersState,
} from "@/lib/folders";
import { cn } from "@/lib/utils";

import { railItemLabel } from "./RailMenuRow";

// The SDK exports the icon component under a lowercase experimental_ name,
// which JSX would read as an intrinsic element, so it needs an alias.
const SidebarNavigationIcon = experimental_SidebarNavigationIcon;

function FolderRow({
  folder,
  canMoveUp,
  canMoveDown,
  onMove,
  onRename,
  onDelete,
}: {
  folder: Folder;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (folder: Folder, direction: FolderMoveDirection) => void;
  onRename: (folder: Folder) => void;
  onDelete: (folder: Folder) => void;
}) {
  return (
    <li
      data-customize-folder={folder.id}
      className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5"
    >
      <Icon
        name={folder.icon}
        fallback={DEFAULT_FOLDER_ICON}
        className="size-4 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1 truncate text-sm">{folder.name}</span>
      <span className="shrink-0 text-xs text-muted-foreground">
        Иконок: {folder.itemIds.length}
      </span>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        aria-label={`Выше: ${folder.name}`}
        disabled={!canMoveUp}
        onClick={() => onMove(folder, "up")}
        className="size-7"
      >
        <Icon name="ArrowUp" className="size-3.5" aria-hidden="true" />
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        aria-label={`Ниже: ${folder.name}`}
        disabled={!canMoveDown}
        onClick={() => onMove(folder, "down")}
        className="size-7"
      >
        <Icon name="ArrowDown" className="size-3.5" aria-hidden="true" />
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => onRename(folder)}
      >
        Переименовать
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        aria-label={`Удалить папку ${folder.name}`}
        onClick={() => onDelete(folder)}
        className="size-7 text-muted-foreground hover:text-destructive"
      >
        <Icon name="Trash2" className="size-3.5" aria-hidden="true" />
      </Button>
    </li>
  );
}

function SingleIconRow({
  item,
  canMoveUp,
  canMoveDown,
  onMove,
  onSetVisible,
}: {
  item: ExperimentalSidebarNavigationItem;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (item: ExperimentalSidebarNavigationItem, direction: FolderMoveDirection) => void;
  onSetVisible: (itemId: string, isVisible: boolean) => void;
}) {
  const label = railItemLabel(item);
  return (
    <li
      data-customize-item={item.id}
      data-hidden={item.isVisible ? undefined : ""}
      className={cn(
        "flex items-center gap-2 rounded-md border border-border px-2 py-1.5",
        !item.isVisible && "opacity-60",
      )}
    >
      <SidebarNavigationIcon icon={item.icon} className="size-4 shrink-0" />
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-sm",
          !item.isVisible && "text-muted-foreground",
        )}
      >
        {label}
      </span>
      <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
        <input
          type="checkbox"
          className="size-3.5 cursor-pointer accent-foreground"
          checked={item.isVisible}
          aria-label={`Показывать «${label}»`}
          onChange={(event) => onSetVisible(item.id, event.target.checked)}
        />
        Видно
      </label>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        aria-label={`Выше: ${label}`}
        disabled={!canMoveUp}
        onClick={() => onMove(item, "up")}
        className="size-7"
      >
        <Icon name="ArrowUp" className="size-3.5" aria-hidden="true" />
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        aria-label={`Ниже: ${label}`}
        disabled={!canMoveDown}
        onClick={() => onMove(item, "down")}
        className="size-7"
      >
        <Icon name="ArrowDown" className="size-3.5" aria-hidden="true" />
      </Button>
    </li>
  );
}

/**
 * The plugin's own rail editor, opened from "Настроить рейл…". One modal holds
 * everything the arrangement controls from a single place: the folders with
 * their arrows, rename and delete, and the single icons in the mixed rail
 * order with their arrows and visibility switch. "Редактор BB…" still hands
 * over to bb's own editor for the host-side settings this plugin does not own.
 */
export function RailCustomizeDialog({
  open,
  onClose,
  state,
  isLoaded,
  items,
  actions,
  onRenameFolder,
  onDeleteFolder,
  onSetOrder,
  onSetVisible,
}: {
  open: boolean;
  onClose: () => void;
  state: RailFoldersState;
  isLoaded: boolean;
  items: readonly ExperimentalSidebarNavigationItem[];
  actions: ExperimentalSidebarNavigationActions;
  onRenameFolder: (folder: Folder) => void;
  onDeleteFolder: (folder: Folder) => void;
  onSetOrder: (order: string[]) => void;
  onSetVisible: (itemId: string, isVisible: boolean) => void;
}) {
  const folders = orderedFolders(state);
  const sequence = railEditableSequence(state, items);
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const singleIcons = singleIconIds(state, items).flatMap((itemId) => {
    const item = itemsById.get(itemId);
    return item === undefined ? [] : [item];
  });

  // The dialog owns the host's item list, so it materializes the rail order
  // itself and saves it whole. A folder in an old folders-only order can then
  // step past single icons too, and the server never has to guess them.
  const moveFolderTo = (folder: Folder, direction: FolderMoveDirection) => {
    const next = moveFolder(state, items, folder.id, direction);
    if (next !== state) onSetOrder(next.order);
  };

  const moveSingle = (
    item: ExperimentalSidebarNavigationItem,
    direction: FolderMoveDirection,
  ) => {
    const next = moveItemInOrder(state, items, item.id, direction);
    if (next !== state) onSetOrder(next.order);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Настроить рейл</DialogTitle>
          <DialogDescription>
            Папки и одиночные иконки рейла: порядок стрелками, видимость
            флажком, переименование и удаление папок.
          </DialogDescription>
        </DialogHeader>

        <section
          aria-labelledby="rail-customize-folders"
          className="flex flex-col gap-2"
        >
          <h3
            id="rail-customize-folders"
            className="text-sm font-medium text-foreground"
          >
            Папки
          </h3>
          {!isLoaded ? (
            <p role="status" className="text-xs text-muted-foreground">
              Загрузка папок…
            </p>
          ) : folders.length === 0 ? (
            <p
              role="status"
              className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground"
            >
              Папок нет — создай через правый клик по иконке рейла.
            </p>
          ) : (
            <ul aria-label="Папки" className="flex flex-col gap-1.5">
              {folders.map((folder) => {
                const position = sequence.indexOf(folder.id);
                return (
                  <FolderRow
                    key={folder.id}
                    folder={folder}
                    canMoveUp={position > 0}
                    canMoveDown={
                      position >= 0 && position < sequence.length - 1
                    }
                    onMove={moveFolderTo}
                    onRename={onRenameFolder}
                    onDelete={onDeleteFolder}
                  />
                );
              })}
            </ul>
          )}
        </section>

        <section
          aria-labelledby="rail-customize-icons"
          className="flex flex-col gap-2"
        >
          <h3
            id="rail-customize-icons"
            className="text-sm font-medium text-foreground"
          >
            Одиночные иконки
          </h3>
          {singleIcons.length === 0 ? (
            <p
              role="status"
              className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground"
            >
              Одиночных иконок нет: все иконки рейла собраны в папки.
            </p>
          ) : (
            <ul aria-label="Одиночные иконки" className="flex flex-col gap-1.5">
              {singleIcons.map((item) => {
                const position = sequence.indexOf(item.id);
                return (
                  <SingleIconRow
                    key={item.id}
                    item={item}
                    canMoveUp={position > 0}
                    canMoveDown={
                      position >= 0 && position < sequence.length - 1
                    }
                    onMove={moveSingle}
                    onSetVisible={onSetVisible}
                  />
                );
              })}
            </ul>
          )}
        </section>

        <DialogFooter className="sm:justify-between">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              onClose();
              actions.openCustomize();
            }}
          >
            <Icon name="SlidersHorizontal" fallback="Settings2" aria-hidden="true" />
            Редактор BB…
          </Button>
          <Button type="button" onClick={onClose}>
            Готово
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
