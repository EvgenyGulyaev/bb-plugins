import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";

import plugin from "./server.js";

const THREAD = "th_kanban";

type ThreadRow = ReturnType<typeof makeThreadResponse>;
type Host = ReturnType<typeof createFakePluginHost>;
const hosts: Host[] = [];
// Mutable so a test can change what threads.list answers across a reload.
let threadRows: ThreadRow[] = [];

async function load(
  options: {
    auto?: boolean;
    legacy?: Record<string, string>;
    threads?: ThreadRow[];
  } = {},
) {
  threadRows = options.threads ?? [];
  const host = createFakePluginHost({
    pluginId: "kanban-board",
    sdk: { threads: { list: async () => threadRows } },
  });
  if (options.auto) await host.bb.storage.kv.set("auto-move", true);
  if (options.legacy)
    await host.bb.storage.kv.set("thread-columns", options.legacy);
  await plugin(host.bb);
  hosts.push(host);
  return host;
}

afterEach(async () => {
  await Promise.all(
    hosts.splice(0).map((host) => host.harness.lifecycle.dispose()),
  );
});

async function placement(host: Host, threadId = THREAD) {
  const { placements } = (await host.harness.behavior.callRpc("board_get", {
    threadIds: [threadId],
  })) as {
    placements: { threadId: string; column: string; pinned: boolean }[];
    autoMove: boolean;
  };
  return placements[0]!;
}

async function enableAuto(host: Host) {
  await host.harness.behavior.callRpc("board_auto_set", { enabled: true });
}

function emit(host: Host, event: "thread.active" | "thread.idle") {
  const thread = makeThreadResponse({ id: THREAD });
  return event === "thread.active"
    ? host.harness.behavior.emitThreadEvent("thread.active", { thread })
    : host.harness.behavior.emitThreadEvent("thread.idle", {
        thread,
        lastAssistantText: null,
      });
}

describe("автопереходы", () => {
  it("выключены по умолчанию и не двигают карточки", async () => {
    const host = await load();
    await emit(host, "thread.active");
    await emit(host, "thread.idle");
    expect(await placement(host)).toEqual({
      threadId: THREAD,
      column: "backlog",
      pinned: false,
    });
  });

  it("active → в работе, idle → на проверке, повторный active → в работе", async () => {
    const host = await load();
    await enableAuto(host);
    await emit(host, "thread.active");
    expect(await placement(host)).toMatchObject({
      column: "in_progress",
      pinned: false,
    });
    await emit(host, "thread.idle");
    expect(await placement(host)).toMatchObject({ column: "review" });
    await emit(host, "thread.active");
    expect(await placement(host)).toMatchObject({ column: "in_progress" });
  });

  it("idle из очереди не двигает карточку", async () => {
    const host = await load();
    await enableAuto(host);
    await emit(host, "thread.idle");
    expect(await placement(host)).toMatchObject({ column: "backlog" });
  });

  it("ручной перенос закрепляет карточку против автопереходов", async () => {
    const host = await load();
    await enableAuto(host);
    await host.harness.behavior.callRpc("board_move", {
      threadId: THREAD,
      column: "done",
    });
    await emit(host, "thread.active");
    await emit(host, "thread.idle");
    expect(await placement(host)).toEqual({
      threadId: THREAD,
      column: "done",
      pinned: true,
    });
  });

  it("перенос в очередь возвращает карточку автоматике", async () => {
    const host = await load();
    await enableAuto(host);
    await host.harness.behavior.callRpc("board_move", {
      threadId: THREAD,
      column: "review",
    });
    expect(await placement(host)).toMatchObject({ pinned: true });
    await host.harness.behavior.callRpc("board_move", {
      threadId: THREAD,
      column: "backlog",
    });
    expect(await placement(host)).toMatchObject({ pinned: false });
    await emit(host, "thread.active");
    expect(await placement(host)).toMatchObject({ column: "in_progress" });
  });

  it("старые записи без pinned считаются закреплёнными", async () => {
    const host = await load({ legacy: { [THREAD]: "done" } });
    await enableAuto(host);
    await emit(host, "thread.active");
    expect(await placement(host)).toEqual({
      threadId: THREAD,
      column: "done",
      pinned: true,
    });
  });

  it("включение догоняет уже работающие потоки", async () => {
    const host = await load({
      threads: [makeThreadResponse({ id: THREAD, status: "active" })],
    });
    await enableAuto(host);
    expect(await placement(host)).toMatchObject({ column: "in_progress" });
  });

  it("перезагрузка догоняет пропущенные переходы", async () => {
    const host = await load();
    await enableAuto(host);
    await emit(host, "thread.active");
    expect(await placement(host)).toMatchObject({ column: "in_progress" });
    threadRows = [makeThreadResponse({ id: THREAD, status: "idle" })];
    const reloaded = await host.harness.lifecycle.reload(plugin);
    hosts[hosts.indexOf(host)] = reloaded;
    expect(await placement(reloaded)).toMatchObject({ column: "review" });
  });

  it("CLI move закрепляет, CLI auto показывает и переключает режим", async () => {
    const host = await load();
    const moved = await host.harness.behavior.runCli([
      "move",
      THREAD,
      "done",
    ]);
    expect(moved.exitCode).toBe(0);
    expect(await placement(host)).toMatchObject({ column: "done", pinned: true });

    const off = await host.harness.behavior.runCli(["auto"]);
    expect(off.stdout).toContain("off");
    const on = await host.harness.behavior.runCli(["auto", "on"]);
    expect(on.exitCode).toBe(0);
    const board = (await host.harness.behavior.callRpc("board_get", {
      threadIds: [THREAD],
    })) as { autoMove: boolean };
    expect(board.autoMove).toBe(true);
  });
});
