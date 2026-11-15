import type { ReactNode } from "react";
import type {
  ExperimentalSidebarNavigationActions,
  ExperimentalSidebarNavigationItem,
} from "@get-bb/plugin-sdk/app";

import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { Icon } from "@/components/ui/icon";
import { DEFAULT_FOLDER_ICON, type Folder } from "@/lib/folders";

export interface ItemMenuActions {
  folders: readonly Folder[];
  onCreateFolder: (item: ExperimentalSidebarNavigationItem) => void;
  onAddToFolder: (
    item: ExperimentalSidebarNavigationItem,
    folderId: string,
  ) => void;
  onRemoveFromFolder: (item: ExperimentalSidebarNavigationItem) => void;
}

/**
 * The context menu shared by a rail icon, a folder member and an overflow row.
 * Grouped icons reach "Убрать из папки" through this menu because they are no
 * longer on the rail itself.
 */
export function ItemContextMenu({
  item,
  actions,
  menu,
}: {
  item: ExperimentalSidebarNavigationItem;
  actions: ExperimentalSidebarNavigationActions;
  menu: ItemMenuActions;
}): ReactNode {
  const currentFolder =
    menu.folders.find((folder) => folder.itemIds.includes(item.id)) ?? null;

  return (
    <ContextMenuContent>
      <ContextMenuLabel className="truncate">{item.label}</ContextMenuLabel>
      <ContextMenuItem onSelect={() => menu.onCreateFolder(item)}>
        <Icon name="FolderPlus" className="size-4" aria-hidden="true" />
        Новая папка с этой иконкой
      </ContextMenuItem>
      {menu.folders.length === 0 ? null : (
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <Icon name="FolderInput" className="size-4" aria-hidden="true" />
            Добавить в папку
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {menu.folders.map((folder) => (
              <ContextMenuItem
                key={folder.id}
                onSelect={() => menu.onAddToFolder(item, folder.id)}
              >
                <Icon
                  name={folder.icon}
                  fallback={DEFAULT_FOLDER_ICON}
                  className="size-4"
                  aria-hidden="true"
                />
                <span className="truncate">{folder.name}</span>
                {folder.itemIds.includes(item.id) ? (
                  <Icon
                    name="Check"
                    className="ml-auto size-4"
                    aria-hidden="true"
                  />
                ) : null}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
      )}
      <ContextMenuItem
        disabled={currentFolder === null}
        onSelect={() => menu.onRemoveFromFolder(item)}
      >
        <Icon name="FolderMinus" className="size-4" aria-hidden="true" />
        Убрать из папки
      </ContextMenuItem>
      {item.pluginId === null ? null : (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => actions.openDetails(item.id)}>
            <Icon name="Info" className="size-4" aria-hidden="true" />
            Детали плагина
          </ContextMenuItem>
        </>
      )}
    </ContextMenuContent>
  );
}
