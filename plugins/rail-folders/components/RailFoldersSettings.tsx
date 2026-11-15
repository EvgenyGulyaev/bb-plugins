import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { experimental_useSidebarNavigation } from "@get-bb/plugin-sdk/app";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { useRailFolders } from "@/hooks/useRailFolders";
import {
  DEFAULT_FOLDER_ICON,
  moveFolder,
  orderedFolders,
  railEditableSequence,
  type Folder,
} from "@/lib/folders";

import { DeleteFolderDialog } from "./FolderDialogs";

/** Move one member past a neighbour, keeping every other slot. */
function moveMember(
  itemIds: readonly string[],
  index: number,
  offset: -1 | 1,
): string[] {
  const next = [...itemIds];
  const [moved] = next.splice(index, 1);
  if (moved === undefined) return [...itemIds];
  next.splice(index + offset, 0, moved);
  return next;
}

function FolderRow({
  folder,
  canMoveUp,
  canMoveDown,
  onSave,
  onMove,
  onReorderItems,
  onDelete,
}: {
  folder: Folder;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onSave: (folder: Folder, name: string, icon: string) => void;
  onMove: (folder: Folder, direction: "up" | "down") => void;
  onReorderItems: (folder: Folder, itemIds: string[]) => void;
  onDelete: (folder: Folder) => void;
}) {
  const [name, setName] = useState(folder.name);
  const [icon, setIcon] = useState(folder.icon);

  useEffect(() => {
    setName(folder.name);
    setIcon(folder.icon);
  }, [folder.name, folder.icon]);

  const nameDirty = name.trim() !== "" && name.trim() !== folder.name;
  const iconDirty = icon.trim() !== "" && icon.trim() !== folder.icon;

  return (
    <li
      data-folder-row={folder.id}
      className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2"
    >
      <Icon
        name={folder.icon}
        fallback={DEFAULT_FOLDER_ICON}
        className="size-4 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
      <Input
        aria-label={`Название папки ${folder.name}`}
        value={name}
        maxLength={60}
        onChange={(event) => setName(event.target.value)}
        className="h-8 min-w-0 flex-1"
      />
      <Input
        aria-label={`Иконка папки ${folder.name}`}
        value={icon}
        maxLength={80}
        spellCheck={false}
        onChange={(event) => setIcon(event.target.value)}
        className="h-8 w-32 font-mono text-xs"
      />
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={!nameDirty && !iconDirty}
        onClick={() => onSave(folder, name, icon)}
      >
        Сохранить
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        aria-label={`Выше: ${folder.name}`}
        disabled={!canMoveUp}
        onClick={() => onMove(folder, "up")}
        className="size-8"
      >
        <Icon name="ArrowUp" className="size-4" aria-hidden="true" />
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        aria-label={`Ниже: ${folder.name}`}
        disabled={!canMoveDown}
        onClick={() => onMove(folder, "down")}
        className="size-8"
      >
        <Icon name="ArrowDown" className="size-4" aria-hidden="true" />
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        aria-label={`Удалить папку ${folder.name}`}
        onClick={() => onDelete(folder)}
        className="size-8 text-muted-foreground hover:text-destructive"
      >
        <Icon name="Trash2" className="size-4" aria-hidden="true" />
      </Button>
      <span className="text-xs text-muted-foreground">
        Иконок: {folder.itemIds.length}
      </span>
      {folder.itemIds.length === 0 ? null : (
        <ul
          aria-label={`Участники папки ${folder.name}`}
          className="flex w-full flex-col gap-1"
        >
          {folder.itemIds.map((itemId, memberIndex) => (
            <li
              key={itemId}
              data-folder-member={itemId}
              className="flex items-center gap-2 rounded-sm bg-muted/50 px-2 py-1"
            >
              <span
                title={itemId}
                className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground"
              >
                {itemId}
              </span>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`Выше в папке: ${itemId}`}
                disabled={memberIndex === 0}
                onClick={() =>
                  onReorderItems(
                    folder,
                    moveMember(folder.itemIds, memberIndex, -1),
                  )
                }
                className="size-6"
              >
                <Icon name="ArrowUp" className="size-3.5" aria-hidden="true" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`Ниже в папке: ${itemId}`}
                disabled={memberIndex === folder.itemIds.length - 1}
                onClick={() =>
                  onReorderItems(
                    folder,
                    moveMember(folder.itemIds, memberIndex, 1),
                  )
                }
                className="size-6"
              >
                <Icon name="ArrowDown" className="size-3.5" aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * Plugin settings page: create, rename, re-icon, reorder and delete folders.
 * Same RPCs as the rail's context menus, so both surfaces stay in sync through
 * the realtime signal.
 */
export function RailFoldersSettings() {
  const { items } = experimental_useSidebarNavigation();
  const { state, isLoaded, error, mutate } = useRailFolders();
  const [newName, setNewName] = useState("");
  const [newIcon, setNewIcon] = useState(DEFAULT_FOLDER_ICON);
  const [deleteTarget, setDeleteTarget] = useState<Folder | null>(null);

  const folders = orderedFolders(state);
  // The arrows step through the rail the user sees, single icons included. On
  // an old folders-only order that means materializing the drawn sequence
  // first, so a folder can move past the icons the order never mentioned.
  const sequence = railEditableSequence(state, items);

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (newName.trim() === "") return;
    const created = await mutate("folders_create", {
      name: newName,
      icon: newIcon.trim() === "" ? DEFAULT_FOLDER_ICON : newIcon,
    });
    if (created) {
      setNewName("");
      setNewIcon(DEFAULT_FOLDER_ICON);
    }
  };

  const save = async (folder: Folder, name: string, icon: string) => {
    if (name.trim() !== folder.name) {
      await mutate("folders_rename", { id: folder.id, name });
    }
    if (icon.trim() !== folder.icon) {
      await mutate("folders_set_icon", { id: folder.id, icon });
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {error === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <form onSubmit={create} className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Название новой папки"
          placeholder="Новая папка"
          value={newName}
          maxLength={60}
          onChange={(event) => setNewName(event.target.value)}
          className="h-8 min-w-40 flex-1"
        />
        <Input
          aria-label="Иконка новой папки"
          value={newIcon}
          maxLength={80}
          spellCheck={false}
          onChange={(event) => setNewIcon(event.target.value)}
          className="h-8 w-36 font-mono text-xs"
        />
        <Button type="submit" size="sm" disabled={newName.trim() === ""}>
          <Icon name="FolderPlus" className="size-4" aria-hidden="true" />
          Создать папку
        </Button>
      </form>
      <p className="text-xs text-muted-foreground">
        Иконка — имя иконки BB, например Folder, Briefcase или Terminal.
      </p>

      {!isLoaded ? (
        <p role="status" className="text-sm text-muted-foreground">
          Загрузка папок…
        </p>
      ) : folders.length === 0 ? (
        <p
          role="status"
          className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"
        >
          Папок пока нет. Создайте первую здесь или правым кликом по иконке в
          рейле.
        </p>
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Папки">
          {folders.map((folder) => {
            // The arrows step through the mixed rail order, so a folder can
            // cross a single icon anchor as well as a sibling folder.
            const position = sequence.indexOf(folder.id);
            return (
              <FolderRow
                key={folder.id}
                folder={folder}
                canMoveUp={position > 0}
                canMoveDown={
                  position >= 0 && position < sequence.length - 1
                }
                onSave={(target, name, icon) => {
                  void save(target, name, icon);
                }}
                onMove={(target, direction) => {
                  const next = moveFolder(state, items, target.id, direction);
                  if (next === state) return;
                  void mutate("rail_set_order", { order: next.order });
                }}
                onReorderItems={(target, itemIds) => {
                  void mutate("folders_reorder_items", {
                    id: target.id,
                    itemIds,
                  });
                }}
                onDelete={setDeleteTarget}
              />
            );
          })}
        </ul>
      )}

      <DeleteFolderDialog
        folder={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget !== null) {
            void mutate("folders_delete", { id: deleteTarget.id });
          }
        }}
      />
    </div>
  );
}
