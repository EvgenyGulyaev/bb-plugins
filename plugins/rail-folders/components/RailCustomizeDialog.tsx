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
  folderById,
  moveFolder,
  moveItemInOrder,
  railEditableSequence,
  type Folder,
  type FolderMoveDirection,
  type RailFoldersState,
} from "@/lib/folders";
import { cn } from "@/lib/utils";

import { railItemLabel } from "./RailMenuRow";

// The SDK exports the icon component under a lowercase experimental_ name,
// which JSX would read as an intrinsic element, so it needs an alias.
const SidebarNavigationIcon = experimental_SidebarNavigationIcon;

/** The row's slot in the rail, numbered from 1 like the rail is drawn. */
function PositionBadge({ position }: { position: number }) {
  return (
    <span
      data-customize-badge={position}
      className="w-5 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground"
    >
      {position}
    </span>
  );
}

function MoveButtons({
  label,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
}: {
  label: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  return (
    <>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        aria-label={`Выше: ${label}`}
        disabled={!canMoveUp}
        onClick={onMoveUp}
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
        onClick={onMoveDown}
        className="size-7"
      >
        <Icon name="ArrowDown" className="size-3.5" aria-hidden="true" />
      </Button>
    </>
  );
}

function FolderRow({
  folder,
  position,
  canMoveUp,
  canMoveDown,
  onMove,
  onRename,
  onDelete,
}: {
  folder: Folder;
  position: number;
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
      <PositionBadge position={position} />
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
      <MoveButtons
        label={folder.name}
        canMoveUp={canMoveUp}
        canMoveDown={canMoveDown}
        onMoveUp={() => onMove(folder, "up")}
        onMoveDown={() => onMove(folder, "down")}
      />
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
  position,
  canMoveUp,
  canMoveDown,
  onMove,
  onSetVisible,
}: {
  item: ExperimentalSidebarNavigationItem;
  position: number;
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
      <PositionBadge position={position} />
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
      <MoveButtons
        label={label}
        canMoveUp={canMoveUp}
        canMoveDown={canMoveDown}
        onMoveUp={() => onMove(item, "up")}
        onMoveDown={() => onMove(item, "down")}
      />
    </li>
  );
}

/**
 * The plugin's own rail editor, opened from "Настроить рейл…". It lists the
 * rail top to bottom in one list: every folder and every single icon in the
 * exact slots the rail draws them, hidden icons included. An arrow saves the
 * new order, the state comes back from the RPC, and the row moves right there,
 * so the dialog is a live preview of the rail instead of two static sections.
 * "Редактор BB…" still hands over to bb's own editor for the host-side
 * settings this plugin does not own.
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
  const sequence = railEditableSequence(state, items);
  const folders = sequence.filter((id) => folderById(state, id) !== null);
  const itemsById = new Map(items.map((item) => [item.id, item]));

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
          aria-labelledby="rail-customize-order"
          className="flex flex-col gap-2"
        >
          <h3
            id="rail-customize-order"
            className="text-sm font-medium text-foreground"
          >
            Порядок рейла
          </h3>
          <p className="text-xs text-muted-foreground">
            Строки идут так же, как иконки на рейле; стрелки двигают строку.
          </p>
          {!isLoaded ? (
            <p role="status" className="text-xs text-muted-foreground">
              Загрузка папок…
            </p>
          ) : (
            <>
              {folders.length > 0 ? null : (
                <p
                  role="status"
                  className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground"
                >
                  Папок нет — создай через правый клик по иконке рейла.
                </p>
              )}
              {sequence.length === 0 ? (
                <p role="status" className="text-xs text-muted-foreground">
                  Иконок рейла нет.
                </p>
              ) : (
                <ul aria-label="Порядок рейла" className="flex flex-col gap-1.5">
                  {sequence.map((id, index) => {
                    const position = index + 1;
                    const canMoveUp = index > 0;
                    const canMoveDown = index < sequence.length - 1;
                    const folder = folderById(state, id);
                    if (folder !== null) {
                      return (
                        <FolderRow
                          key={`folder:${folder.id}`}
                          folder={folder}
                          position={position}
                          canMoveUp={canMoveUp}
                          canMoveDown={canMoveDown}
                          onMove={moveFolderTo}
                          onRename={onRenameFolder}
                          onDelete={onDeleteFolder}
                        />
                      );
                    }
                    const item = itemsById.get(id);
                    if (item === undefined) return null;
                    return (
                      <SingleIconRow
                        key={`item:${item.id}`}
                        item={item}
                        position={position}
                        canMoveUp={canMoveUp}
                        canMoveDown={canMoveDown}
                        onMove={moveSingle}
                        onSetVisible={onSetVisible}
                      />
                    );
                  })}
                </ul>
              )}
            </>
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
