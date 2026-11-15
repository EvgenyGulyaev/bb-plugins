import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";

import { RAIL_FOLDERS_CHANGED, RAIL_STORAGE_KEY } from "./lib/folders.js";
import plugin, { rpcContract } from "./server.js";

type Host = ReturnType<typeof createFakePluginHost>;

const hosts: Host[] = [];

async function load(seed?: unknown) {
  const host = createFakePluginHost({
    pluginId: "rail-folders",
    sdk: {
      system: {
        uiPreferences: {
          list: (async () => ({
            preferences: {
              "sidebar.navigationProvider": {
                revision: 7,
                value: "navigation/rail",
              },
            },
          })) as never,
          set: (async (args: {
            key: string;
            value: string;
            expectedRevision: number;
          }) => ({
            key: args.key,
            revision: args.expectedRevision + 1,
            value: args.value,
          })) as never,
        },
      },
    },
  });
  if (seed !== undefined) await host.bb.storage.kv.set(RAIL_STORAGE_KEY, seed);
  await plugin(host.bb);
  hosts.push(host);
  return host;
}

afterEach(async () => {
  await Promise.all(
    hosts.splice(0).map((host) => host.harness.lifecycle.dispose()),
  );
});

async function state(host: Host) {
  return (await host.harness.behavior.callRpc("rail_state", null)) as {
    state: {
      folders: { id: string; name: string; icon: string; itemIds: string[] }[];
      order: string[];
    };
  };
}

async function create(
  host: Host,
  input: { name: string; icon: string; itemIds?: string[] },
) {
  return (await host.harness.behavior.callRpc("folders_create", input)) as {
    state: { folders: { id: string; name: string; itemIds: string[] }[]; order: string[] };
  };
}

describe("rail state", () => {
  it("starts empty and publishes nothing until a mutation", async () => {
    const host = await load();
    expect(await state(host)).toEqual({ state: { folders: [], order: [] } });
    expect(host.harness.inspection.realtimeSignals).toEqual([]);
  });

  it("creates a folder, claims an item and broadcasts the change", async () => {
    const host = await load();
    const { state: after } = await create(host, {
      name: "  Работа ",
      icon: "Briefcase",
      itemIds: ["plugin-a/panel"],
    });

    expect(after.folders).toHaveLength(1);
    expect(after.folders[0]).toMatchObject({
      name: "Работа",
      icon: "Briefcase",
      itemIds: ["plugin-a/panel"],
    });
    expect(after.order).toEqual([after.folders[0]!.id]);
    expect(host.harness.inspection.realtimeSignals).toEqual([
      { channel: RAIL_FOLDERS_CHANGED, payload: {} },
    ]);
    expect(await host.bb.storage.kv.get(RAIL_STORAGE_KEY)).toEqual(after);
  });

  it("normalizes a stale or broken stored arrangement on read", async () => {
    const host = await load({
      folders: [
        { id: "ok", name: "A", icon: "Folder", itemIds: ["one", "one"] },
        { id: "ok", name: "Dupe", icon: "Folder", itemIds: [] },
        { id: "bad", name: " ", icon: "Folder", itemIds: [] },
      ],
      order: ["ok", "ok", "two"],
    });
    expect((await state(host)).state).toEqual({
      folders: [{ id: "ok", name: "A", icon: "Folder", itemIds: ["one"] }],
      order: ["ok", "two"],
    });
  });

  it("moves an item between folders instead of duplicating it", async () => {
    const host = await load();
    const first = await create(host, {
      name: "A",
      icon: "Folder",
      itemIds: ["plugin-a/panel"],
    });
    const second = await create(host, { name: "B", icon: "Folder" });
    const folderA = first.state.folders[0]!.id;
    const folderB = second.state.folders[1]!.id;

    const added = (await host.harness.behavior.callRpc("folders_add_item", {
      folderId: folderB,
      itemId: "plugin-a/panel",
    })) as { state: { folders: { id: string; itemIds: string[] }[] } };
    expect(added.state.folders).toEqual([
      expect.objectContaining({ id: folderA, itemIds: [] }),
      expect.objectContaining({ id: folderB, itemIds: ["plugin-a/panel"] }),
    ]);

    const again = (await host.harness.behavior.callRpc("folders_add_item", {
      folderId: folderB,
      itemId: "plugin-a/panel",
    })) as { state: { folders: { id: string; itemIds: string[] }[] } };
    expect(again.state.folders[1]!.itemIds).toEqual(["plugin-a/panel"]);
    expect(host.harness.inspection.realtimeSignals).toHaveLength(3);
  });

  it("removes an item from its folder", async () => {
    const host = await load();
    const created = await create(host, {
      name: "A",
      icon: "Folder",
      itemIds: ["plugin-a/panel"],
    });
    const removed = (await host.harness.behavior.callRpc(
      "folders_remove_item",
      { itemId: "plugin-a/panel" },
    )) as { state: { folders: { id: string; itemIds: string[] }[] } };
    expect(removed.state.folders[0]!.itemIds).toEqual([]);
    expect(created.state.folders[0]!.id).toBe(removed.state.folders[0]!.id);
  });

  it("renames and re-icons a folder", async () => {
    const host = await load();
    const created = await create(host, { name: "A", icon: "Folder" });
    const id = created.state.folders[0]!.id;
    await host.harness.behavior.callRpc("folders_rename", { id, name: " Дом " });
    const { state: after } = (await host.harness.behavior.callRpc(
      "folders_set_icon",
      { id, icon: " Home " },
    )) as { state: { folders: { name: string; icon: string }[] } };
    expect(after.folders[0]).toMatchObject({ name: "Дом", icon: "Home" });
  });

  it("deletes a folder and leaves its members ungrouped", async () => {
    const host = await load();
    const created = await create(host, {
      name: "A",
      icon: "Folder",
      itemIds: ["plugin-a/panel"],
    });
    const id = created.state.folders[0]!.id;
    const after = (await host.harness.behavior.callRpc("folders_delete", {
      id,
    })) as { state: { folders: unknown[]; order: string[] } };
    expect(after.state).toEqual({ folders: [], order: [] });
  });

  it("serializes concurrent mutations so neither folder is lost", async () => {
    const host = await load();
    await Promise.all([
      create(host, { name: "A", icon: "Folder" }),
      create(host, { name: "B", icon: "Folder" }),
    ]);
    const { state: after } = await state(host);
    expect(after.folders.map((folder) => folder.name)).toEqual(["A", "B"]);
    expect(host.harness.inspection.realtimeSignals).toHaveLength(2);
  });

  it("reorders folders past each other", async () => {
    const host = await load();
    const first = await create(host, { name: "A", icon: "Folder" });
    await create(host, { name: "B", icon: "Folder" });
    const idA = first.state.folders[0]!.id;
    const moved = (await host.harness.behavior.callRpc("folders_move", {
      id: idA,
      direction: "down",
    })) as { state: { order: string[] } };
    expect(moved.state.order).toHaveLength(2);
    expect(moved.state.order[1]).toBe(idA);
  });

  it("reorders members and broadcasts the new order", async () => {
    const host = await load();
    const created = await create(host, {
      name: "A",
      icon: "Folder",
      itemIds: ["one", "two", "three"],
    });
    const id = created.state.folders[0]!.id;

    const after = (await host.harness.behavior.callRpc(
      "folders_reorder_items",
      { id, itemIds: ["three", "one", "two"] },
    )) as { state: { folders: { itemIds: string[] }[] } };

    expect(after.state.folders[0]!.itemIds).toEqual(["three", "one", "two"]);
    expect(host.harness.inspection.realtimeSignals).toHaveLength(2);
    expect(await host.bb.storage.kv.get(RAIL_STORAGE_KEY)).toEqual(after.state);
  });

  it("rejects a member order that is not a permutation", async () => {
    const host = await load();
    const created = await create(host, {
      name: "A",
      icon: "Folder",
      itemIds: ["one", "two", "three"],
    });
    const id = created.state.folders[0]!.id;

    await expect(
      host.harness.behavior.callRpc("folders_reorder_items", {
        id,
        itemIds: ["one", "two"],
      }),
    ).rejects.toThrow(/permutation/);
    await expect(
      host.harness.behavior.callRpc("folders_reorder_items", {
        id,
        itemIds: ["one", "two", "two"],
      }),
    ).rejects.toThrow(/validation/);
    await expect(
      host.harness.behavior.callRpc("folders_reorder_items", {
        id,
        itemIds: ["one", "two", "four"],
      }),
    ).rejects.toThrow(/permutation/);
    await expect(
      host.harness.behavior.callRpc("folders_reorder_items", {
        id: "folder_gone",
        itemIds: [],
      }),
    ).rejects.toThrow(/folder_gone/);

    expect(host.harness.inspection.realtimeSignals).toHaveLength(1);
    expect((await state(host)).state.folders[0]!.itemIds).toEqual([
      "one",
      "two",
      "three",
    ]);
  });

  it("does not broadcast a member reorder that changes nothing", async () => {
    const host = await load();
    const created = await create(host, {
      name: "A",
      icon: "Folder",
      itemIds: ["one", "two"],
    });
    const id = created.state.folders[0]!.id;

    await host.harness.behavior.callRpc("folders_reorder_items", {
      id,
      itemIds: ["one", "two"],
    });

    expect(host.harness.inspection.realtimeSignals).toHaveLength(1);
  });

  it("moves a folder to an absolute index and clamps it", async () => {
    const host = await load();
    const first = await create(host, { name: "A", icon: "Folder" });
    await create(host, { name: "B", icon: "Folder" });
    const third = await create(host, { name: "C", icon: "Folder" });
    const idA = first.state.folders[0]!.id;
    const idC = third.state.folders[2]!.id;

    const moved = (await host.harness.behavior.callRpc("folders_reorder", {
      id: idC,
      index: 0,
    })) as { state: { order: string[]; folders: { id: string }[] } };
    expect(moved.state.order).toEqual([
      idC,
      idA,
      third.state.folders[1]!.id,
    ]);
    expect(moved.state.folders.map((folder) => folder.id)).toEqual(
      moved.state.order,
    );

    const clamped = (await host.harness.behavior.callRpc("folders_reorder", {
      id: idC,
      index: 99,
    })) as { state: { order: string[] } };
    expect(clamped.state.order[clamped.state.order.length - 1]).toBe(idC);
    expect(host.harness.inspection.realtimeSignals).toHaveLength(5);
  });

  it("does not broadcast a folder reorder that changes nothing", async () => {
    const host = await load();
    const first = await create(host, { name: "A", icon: "Folder" });
    await create(host, { name: "B", icon: "Folder" });
    const idA = first.state.folders[0]!.id;

    await host.harness.behavior.callRpc("folders_reorder", {
      id: idA,
      index: 0,
    });

    await expect(
      host.harness.behavior.callRpc("folders_reorder", {
        id: "folder_gone",
        index: 0,
      }),
    ).rejects.toThrow(/folder_gone/);

    expect(host.harness.inspection.realtimeSignals).toHaveLength(2);
  });

  it("rejects mutations of a folder that no longer exists", async () => {
    const host = await load();
    await expect(
      host.harness.behavior.callRpc("folders_rename", {
        id: "folder_gone",
        name: "X",
      }),
    ).rejects.toThrow(/folder_gone/);
    await expect(
      host.harness.behavior.callRpc("folders_delete", { id: "folder_gone" }),
    ).rejects.toThrow(/folder_gone/);
    await expect(
      host.harness.behavior.callRpc("folders_add_item", {
        folderId: "folder_gone",
        itemId: "plugin-a/panel",
      }),
    ).rejects.toThrow(/folder_gone/);
  });

  it("rejects a blank folder name at the wire boundary", async () => {
    const host = await load();
    await expect(
      host.harness.behavior.callRpc("folders_create", {
        name: "   ",
        icon: "Folder",
      }),
    ).rejects.toThrow();
  });

  it("declares every mutation in the shared contract", () => {
    expect(Object.keys(rpcContract).sort()).toEqual([
      "folders_add_item",
      "folders_create",
      "folders_delete",
      "folders_move",
      "folders_remove_item",
      "folders_rename",
      "folders_reorder",
      "folders_reorder_items",
      "folders_set_icon",
      "rail_state",
    ]);
  });
});

describe("install", () => {
  it("makes this navigation the active provider on a fresh install", async () => {
    const host = await load();
    await host.harness.lifecycle.install();

    expect(host.harness.inspection.sdk.callsTo("system.uiPreferences.set")).toEqual([
      [
        {
          key: "sidebar.navigationProvider",
          value: "rail-folders/rail-folders",
          expectedRevision: 7,
        },
      ],
    ]);
  });
});
