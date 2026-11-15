// bb-plugin-rail-folders — backend entry.
//
// The rail arrangement lives in bb.storage.kv under "rail-folders". Every
// mutation runs through the shared pure helpers in lib/folders.ts, writes the
// whole state back, and publishes "rail-folders-changed" so every open window
// reloads. The frontend never writes storage directly; it calls these RPCs.
import { randomUUID } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

import {
  RAIL_FOLDERS_CHANGED,
  RAIL_STORAGE_KEY,
  addItemToFolder,
  createFolder,
  deleteFolder,
  folderById,
  folderIconSchema,
  folderNameSchema,
  itemIdSchema,
  moveFolder,
  normalizeState,
  railFoldersStateSchema,
  removeItemFromFolder,
  renameFolder,
  setFolderIcon,
  type RailFoldersState,
} from "./lib/folders.js";

const folderIdSchema = z.string().min(1).max(120);
const stateOutput = z.object({ state: railFoldersStateSchema });

export const rpcContract = defineRpcContract({
  rail_state: {
    input: z.null(),
    output: stateOutput,
  },
  folders_create: {
    input: z.object({
      name: folderNameSchema,
      icon: folderIconSchema,
      itemIds: z.array(itemIdSchema).max(200).optional(),
    }),
    output: stateOutput,
  },
  folders_rename: {
    input: z.object({ id: folderIdSchema, name: folderNameSchema }),
    output: stateOutput,
  },
  folders_set_icon: {
    input: z.object({ id: folderIdSchema, icon: folderIconSchema }),
    output: stateOutput,
  },
  folders_delete: {
    input: z.object({ id: folderIdSchema }),
    output: stateOutput,
  },
  folders_add_item: {
    input: z.object({ folderId: folderIdSchema, itemId: itemIdSchema }),
    output: stateOutput,
  },
  folders_remove_item: {
    input: z.object({ itemId: itemIdSchema }),
    output: stateOutput,
  },
  folders_move: {
    input: z.object({
      id: folderIdSchema,
      direction: z.enum(["up", "down"]),
    }),
    output: stateOutput,
  },
});

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  async function readState(): Promise<RailFoldersState> {
    return normalizeState(await bb.storage.kv.get<unknown>(RAIL_STORAGE_KEY));
  }

  async function writeState(state: RailFoldersState) {
    await bb.storage.kv.set(RAIL_STORAGE_KEY, state);
    bb.realtime.publish(RAIL_FOLDERS_CHANGED, {});
    return { state };
  }

  async function mutate(
    update: (state: RailFoldersState) => RailFoldersState,
  ) {
    const state = await readState();
    const next = update(state);
    // The pure helpers return the same object for a no-op, so an idempotent
    // click neither rewrites storage nor wakes every open window.
    return next === state ? { state } : writeState(next);
  }

  function requireFolder(state: RailFoldersState, id: string) {
    const folder = folderById(state, id);
    if (folder === null) throw new Error(`No folder with id ${id}`);
    return folder;
  }

  function nextFolderId(state: RailFoldersState): string {
    let id = `folder_${randomUUID().slice(0, 12)}`;
    while (folderById(state, id) !== null) {
      id = `folder_${randomUUID().slice(0, 12)}`;
    }
    return id;
  }

  bb.rpc.register(rpcContract, {
    rail_state: async () => ({ state: await readState() }),
    folders_create: ({ name, icon, itemIds }) =>
      mutate((state) =>
        createFolder(state, {
          id: nextFolderId(state),
          name,
          icon,
          itemIds: itemIds ?? [],
        }),
      ),
    folders_rename: ({ id, name }) =>
      mutate((state) => {
        requireFolder(state, id);
        return renameFolder(state, id, name);
      }),
    folders_set_icon: ({ id, icon }) =>
      mutate((state) => {
        requireFolder(state, id);
        return setFolderIcon(state, id, icon);
      }),
    folders_delete: ({ id }) =>
      mutate((state) => {
        requireFolder(state, id);
        return deleteFolder(state, id);
      }),
    folders_add_item: ({ folderId, itemId }) =>
      mutate((state) => {
        requireFolder(state, folderId);
        return addItemToFolder(state, folderId, itemId);
      }),
    folders_remove_item: ({ itemId }) =>
      mutate((state) => removeItemFromFolder(state, itemId)),
    folders_move: ({ id, direction }) =>
      mutate((state) => {
        requireFolder(state, id);
        return moveFolder(state, id, direction);
      }),
  });

  // Installing picks this navigation, the same one-time setup bb's own guide
  // suggests for a thread list. Later choices in Settings → Appearance stick.
  bb.onInstall(async () => {
    const { preferences } = await bb.sdk.system.uiPreferences.list();
    await bb.sdk.system.uiPreferences.set({
      key: "sidebar.navigationProvider",
      value: `${bb.pluginId}/rail-folders`,
      expectedRevision: preferences["sidebar.navigationProvider"].revision,
    });
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
