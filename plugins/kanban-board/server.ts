import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const boardColumns = ["backlog", "in_progress", "review", "done"] as const;
export type BoardColumn = (typeof boardColumns)[number];
const columnSchema = z.enum(boardColumns);
const placementSchema = z.object({ threadId: z.string().min(1), column: columnSchema, pinned: z.boolean() });
export const rpcContract = defineRpcContract({
  board_get: {
    input: z.object({ threadIds: z.array(z.string().min(1)).max(500) }).strict(),
    output: z.object({ placements: z.array(placementSchema), autoMove: z.boolean() }),
  },
  board_move: {
    input: z.object({ threadId: z.string().min(1), column: columnSchema }).strict(),
    output: placementSchema,
  },
  board_auto_set: { input: z.object({ enabled: z.boolean() }).strict(), output: z.object({ enabled: z.boolean() }) },
});
const BOARD_CHANGED = "board-changed";
const STORAGE_KEY = "thread-columns";
const AUTO_KEY = "auto-move";
type Placement = z.infer<typeof placementSchema>;
type StoredPlacement = { column: BoardColumn; pinned: boolean };

// Older boards stored a bare column string per thread. Every such placement
// was made by hand, so it reads back as pinned.
const storedSchema = z
  .record(z.string(), z.union([columnSchema, z.object({ column: columnSchema, pinned: z.boolean() }).strict()]))
  .catch({});

// Auto moves never touch a pinned card and never move anything to done:
// finishing work stays a human decision. Parking a card back in the backlog
// hands it to automation again.
export function autoTarget(status: "active" | "idle", current: StoredPlacement | undefined): BoardColumn | null {
  if (current?.pinned) return null;
  const column = current?.column ?? "backlog";
  if (status === "active") return column === "in_progress" ? null : "in_progress";
  return column === "in_progress" ? "review" : null;
}

export default async function plugin(bb: BbPluginApi) {
  async function readPlacements(): Promise<Record<string, StoredPlacement>> {
    const raw = storedSchema.parse((await bb.storage.kv.get(STORAGE_KEY)) ?? {});
    return Object.fromEntries(
      Object.entries(raw).map(([threadId, value]) => [
        threadId,
        typeof value === "string" ? { column: value, pinned: true } : value,
      ]),
    );
  }
  async function readAutoMove(): Promise<boolean> {
    return (await bb.storage.kv.get<boolean>(AUTO_KEY)) === true;
  }
  async function moveThread(threadId: string, column: BoardColumn, pinned: boolean): Promise<Placement> {
    const placements = await readPlacements();
    placements[threadId] = { column, pinned };
    await bb.storage.kv.set(STORAGE_KEY, placements);
    bb.realtime.publish(BOARD_CHANGED, { threadId, column });
    return { threadId, column, pinned };
  }
  async function autoTransition(threadId: string, status: "active" | "idle"): Promise<void> {
    if (!(await readAutoMove())) return;
    const placements = await readPlacements();
    const target = autoTarget(status, placements[threadId]);
    if (target) await moveThread(threadId, target, false);
  }
  // Catch up on transitions missed while the plugin was unloaded, and apply
  // the current state right when auto moves are switched on.
  async function reconcile(): Promise<void> {
    if (!(await readAutoMove())) return;
    // ponytail: one page of 200 threads; upgrade path is offset paging if boards outgrow it.
    const threads = await bb.sdk.threads.list({ limit: 200 });
    const placements = await readPlacements();
    const moved: Placement[] = [];
    for (const thread of threads) {
      if (thread.status !== "active" && thread.status !== "idle") continue;
      const target = autoTarget(thread.status, placements[thread.id]);
      if (!target) continue;
      placements[thread.id] = { column: target, pinned: false };
      moved.push({ threadId: thread.id, column: target, pinned: false });
    }
    if (moved.length === 0) return;
    await bb.storage.kv.set(STORAGE_KEY, placements);
    for (const placement of moved) bb.realtime.publish(BOARD_CHANGED, placement);
  }
  async function setAutoMove(enabled: boolean): Promise<{ enabled: boolean }> {
    await bb.storage.kv.set(AUTO_KEY, enabled);
    bb.realtime.publish(BOARD_CHANGED, { autoMove: enabled });
    if (enabled) await reconcile();
    return { enabled };
  }
  bb.rpc.register(rpcContract, {
    board_get: async ({ threadIds }) => {
      const placements = await readPlacements();
      return {
        placements: threadIds.map((threadId) => ({
          threadId,
          column: placements[threadId]?.column ?? "backlog",
          pinned: placements[threadId]?.pinned ?? false,
        })),
        autoMove: await readAutoMove(),
      };
    },
    // A hand move pins the card against auto moves; the backlog unpins it.
    board_move: ({ threadId, column }) => moveThread(threadId, column, column !== "backlog"),
    board_auto_set: ({ enabled }) => setAutoMove(enabled),
  });
  bb.events.on("thread.active", ({ thread }) => autoTransition(thread.id, "active"));
  bb.events.on("thread.idle", ({ thread }) => autoTransition(thread.id, "idle"));
  bb.cli.register({
    name: "kanban-board",
    summary: "Move threads across the Kanban board",
    commands: [
      { name: "move", summary: "Move a thread (pins it against auto moves)", usage: "bb kanban-board move <thread-id> <column>" },
      { name: "auto", summary: "Show or toggle auto moves", usage: "bb kanban-board auto [on|off]" },
    ],
    async run(argv) {
      const [command, threadId, column] = argv;
      if (command === "auto") {
        const mode = threadId;
        if (mode !== undefined && mode !== "on" && mode !== "off") {
          return { exitCode: 1, stderr: "Usage: bb kanban-board auto [on|off]" };
        }
        if (mode === undefined) return { exitCode: 0, stdout: "auto: " + ((await readAutoMove()) ? "on" : "off") };
        const { enabled } = await setAutoMove(mode === "on");
        return { exitCode: 0, stdout: "auto: " + (enabled ? "on" : "off") };
      }
      if (command !== "move" || !threadId || !column || !boardColumns.includes(column as BoardColumn)) {
        return { exitCode: 1, stderr: "Usage: bb kanban-board move <thread-id> <backlog|in_progress|review|done>" };
      }
      const placement = await moveThread(threadId, column as BoardColumn, column !== "backlog");
      return { exitCode: 0, stdout: placement.threadId + " -> " + placement.column };
    },
  });
  try {
    await reconcile();
  } catch (cause) {
    bb.log.warn("kanban reconcile failed: " + (cause instanceof Error ? cause.message : String(cause)));
  }
}
