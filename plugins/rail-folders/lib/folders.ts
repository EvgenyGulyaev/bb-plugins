import { z } from "zod";

/** Where the rail state lives in `bb.storage.kv`. */
export const RAIL_STORAGE_KEY = "rail-folders";
/** Realtime channel published after every mutation. */
export const RAIL_FOLDERS_CHANGED = "rail-folders-changed";
/** Icon used when a folder is created without a meaningful one. */
export const DEFAULT_FOLDER_ICON = "Folder";
/**
 * `dataTransfer` type carrying the dragged rail item id, shared by the rail
 * buttons, the popover rows and the rail's drop zones.
 */
export const RAIL_ITEM_DRAG_MIME = "text/rail-item-id";
/**
 * Extra `dataTransfer` type put on a folder member's drag, so the rail's free
 * area only offers itself as a target when leaving the folder is possible.
 */
export const RAIL_MEMBER_DRAG_MIME = "text/rail-item-in-folder";

export const folderNameSchema = z.string().trim().min(1).max(60);
export const folderIconSchema = z.string().trim().min(1).max(80);
export const itemIdSchema = z.string().trim().min(1).max(200);

export const folderSchema = z.object({
  id: z.string().min(1),
  name: folderNameSchema,
  icon: folderIconSchema,
  itemIds: z.array(itemIdSchema),
});
export type Folder = z.infer<typeof folderSchema>;

/**
 * The persisted rail arrangement. `order` lists folder ids and ungrouped item
 * ids; anything missing keeps its position from the host's own item order, so
 * a newly installed panel never disappears.
 */
export const railFoldersStateSchema = z.object({
  folders: z.array(folderSchema),
  order: z.array(z.string()),
});
export type RailFoldersState = z.infer<typeof railFoldersStateSchema>;

export const EMPTY_RAIL_STATE: RailFoldersState = { folders: [], order: [] };

/** One slot in the rail: a folder, or a single ungrouped host item. */
export type RailEntry =
  | { kind: "folder"; folder: Folder }
  | { kind: "item"; itemId: string };

/** The part of a host navigation item the layout needs. */
export interface RailItemRef {
  id: string;
  isVisible: boolean;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Tolerant read of persisted state: one broken folder must not wipe the whole
 * arrangement, an item belongs to at most one folder, and duplicates in
 * `order` collapse.
 */
export function normalizeState(value: unknown): RailFoldersState {
  if (typeof value !== "object" || value === null) {
    return { ...EMPTY_RAIL_STATE };
  }
  const raw = value as { folders?: unknown; order?: unknown };
  const folders: Folder[] = [];
  const claimed = new Set<string>();

  if (Array.isArray(raw.folders)) {
    for (const entry of raw.folders) {
      const parsed = folderSchema.safeParse(entry);
      if (!parsed.success) continue;
      const folder = parsed.data;
      if (folders.some((existing) => existing.id === folder.id)) continue;
      const itemIds = unique(folder.itemIds).filter((id) => !claimed.has(id));
      for (const id of itemIds) claimed.add(id);
      folders.push({ ...folder, itemIds });
    }
  }

  const order: string[] = [];
  const seen = new Set<string>();
  if (Array.isArray(raw.order)) {
    for (const entry of raw.order) {
      if (typeof entry !== "string") continue;
      const id = entry.trim();
      if (id === "" || seen.has(id)) continue;
      seen.add(id);
      order.push(id);
    }
  }

  return { folders, order };
}

export function folderById(
  state: RailFoldersState,
  folderId: string,
): Folder | null {
  return state.folders.find((folder) => folder.id === folderId) ?? null;
}

export function folderOfItem(
  state: RailFoldersState,
  itemId: string,
): Folder | null {
  return (
    state.folders.find((folder) => folder.itemIds.includes(itemId)) ?? null
  );
}

function folderIdOf(state: RailFoldersState, itemId: string): string | null {
  return folderOfItem(state, itemId)?.id ?? null;
}

function withFolders(
  state: RailFoldersState,
  folders: Folder[],
): RailFoldersState {
  return { folders, order: state.order };
}

/**
 * Create a folder, optionally claiming items. An item moves out of whichever
 * folder held it before, so membership stays exclusive.
 */
export function createFolder(
  state: RailFoldersState,
  input: {
    id: string;
    name: string;
    icon: string;
    itemIds?: readonly string[];
  },
): RailFoldersState {
  const id = input.id.trim();
  const name = input.name.trim();
  if (id === "" || name === "") return state;
  if (folderById(state, id) !== null) return state;

  const icon = input.icon.trim() === "" ? DEFAULT_FOLDER_ICON : input.icon.trim();
  const claimed = new Set(
    (input.itemIds ?? []).map((itemId) => itemId.trim()).filter(Boolean),
  );
  const members = [...claimed];

  const folders = state.folders.map((folder) => ({
    ...folder,
    itemIds: folder.itemIds.filter((itemId) => !claimed.has(itemId)),
  }));
  folders.push({ id, name, icon, itemIds: members });

  return { folders, order: [...state.order, id] };
}

export function renameFolder(
  state: RailFoldersState,
  folderId: string,
  name: string,
): RailFoldersState {
  const next = name.trim();
  const folder = folderById(state, folderId);
  if (folder === null || next === "" || folder.name === next) return state;
  return withFolders(
    state,
    state.folders.map((candidate) =>
      candidate.id === folderId ? { ...candidate, name: next } : candidate,
    ),
  );
}

export function setFolderIcon(
  state: RailFoldersState,
  folderId: string,
  icon: string,
): RailFoldersState {
  const next = icon.trim();
  const folder = folderById(state, folderId);
  if (folder === null || next === "" || folder.icon === next) return state;
  return withFolders(
    state,
    state.folders.map((candidate) =>
      candidate.id === folderId ? { ...candidate, icon: next } : candidate,
    ),
  );
}

/** Deleting a folder only ungroups its members; no item is removed from bb. */
export function deleteFolder(
  state: RailFoldersState,
  folderId: string,
): RailFoldersState {
  if (folderById(state, folderId) === null) return state;
  return {
    folders: state.folders.filter((folder) => folder.id !== folderId),
    order: state.order.filter((id) => id !== folderId),
  };
}

export function addItemToFolder(
  state: RailFoldersState,
  folderId: string,
  itemId: string,
): RailFoldersState {
  const id = itemId.trim();
  const target = folderById(state, folderId);
  if (target === null || id === "") return state;
  if (target.itemIds.includes(id)) return state;
  if (folderIdOf(state, id) === folderId) return state;
  return withFolders(
    state,
    state.folders.map((folder) => {
      if (folder.id === folderId) {
        return { ...folder, itemIds: [...folder.itemIds, id] };
      }
      if (!folder.itemIds.includes(id)) return folder;
      return {
        ...folder,
        itemIds: folder.itemIds.filter((itemId) => itemId !== id),
      };
    }),
  );
}

export function removeItemFromFolder(
  state: RailFoldersState,
  itemId: string,
): RailFoldersState {
  const id = itemId.trim();
  if (id === "" || folderOfItem(state, id) === null) return state;
  return withFolders(
    state,
    state.folders.map((folder) =>
      folder.itemIds.includes(id)
        ? {
            ...folder,
            itemIds: folder.itemIds.filter((candidate) => candidate !== id),
          }
        : folder,
    ),
  );
}

export type FolderMoveDirection = "up" | "down";

/**
 * Reorder a folder past its nearest sibling folder. Ungrouped item slots keep
 * their place, so a folder moves only among folders.
 */
export function moveFolder(
  state: RailFoldersState,
  folderId: string,
  direction: FolderMoveDirection,
): RailFoldersState {
  const folderIds = new Set(state.folders.map((folder) => folder.id));
  const folderSlots = state.order.filter((id) => folderIds.has(id));
  const index = folderSlots.indexOf(folderId);
  const neighbour = folderSlots[direction === "up" ? index - 1 : index + 1];
  if (index < 0 || neighbour === undefined) return state;

  const order = [...state.order];
  const from = order.indexOf(folderId);
  const to = order.indexOf(neighbour);
  if (from < 0 || to < 0) return state;
  order[from] = neighbour;
  order[to] = folderId;
  return { folders: state.folders, order };
}

/** Members of `folder` that still exist as host items, in the folder's order. */
export function folderMembers(
  folder: Folder,
  knownItemIds: ReadonlySet<string>,
): string[] {
  return folder.itemIds.filter((itemId) => knownItemIds.has(itemId));
}

/** Folders in their saved rail order, then any folder `order` forgot. */
export function orderedFolders(state: RailFoldersState): Folder[] {
  const folders: Folder[] = [];
  const seen = new Set<string>();
  for (const id of state.order) {
    if (seen.has(id)) continue;
    const folder = folderById(state, id);
    if (folder === null) continue;
    seen.add(id);
    folders.push(folder);
  }
  for (const folder of state.folders) {
    if (seen.has(folder.id)) continue;
    seen.add(folder.id);
    folders.push(folder);
  }
  return folders;
}

/**
 * Flatten the arrangement into the order the rail draws: `order` first, then
 * folders it does not mention, then ungrouped items in the host's order.
 * Grouped and hidden items never get a slot of their own; unknown ids are
 * skipped, so a stale saved order cannot hide a plugin.
 */
export function layoutRail(
  state: RailFoldersState,
  items: readonly RailItemRef[],
): RailEntry[] {
  const known = new Set(items.map((item) => item.id));
  const visible = new Set(
    items.filter((item) => item.isVisible).map((item) => item.id),
  );
  const folderIds = new Set(state.folders.map((folder) => folder.id));
  const grouped = new Set(
    state.folders.flatMap((folder) => folder.itemIds),
  );

  const entries: RailEntry[] = [];
  const placed = new Set<string>();

  const placeFolder = (folderId: string) => {
    if (placed.has(folderId)) return;
    const folder = folderById(state, folderId);
    if (folder === null) return;
    placed.add(folderId);
    entries.push({ kind: "folder", folder });
  };
  const placeItem = (itemId: string) => {
    if (placed.has(itemId)) return;
    if (!known.has(itemId) || !visible.has(itemId) || grouped.has(itemId)) {
      return;
    }
    placed.add(itemId);
    entries.push({ kind: "item", itemId });
  };

  for (const key of state.order) {
    if (folderIds.has(key)) placeFolder(key);
    else placeItem(key);
  }
  for (const folder of state.folders) placeFolder(folder.id);
  for (const item of items) placeItem(item.id);

  return entries;
}
