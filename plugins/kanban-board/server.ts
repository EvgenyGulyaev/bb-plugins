import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const boardColumns = ["backlog", "in_progress", "review", "done"] as const;
export type BoardColumn = (typeof boardColumns)[number];
const columnSchema = z.enum(boardColumns);
const placementSchema = z.object({ threadId: z.string().min(1), column: columnSchema });
export const rpcContract = defineRpcContract({
  board_get: { input: z.object({ threadIds: z.array(z.string().min(1)).max(500) }).strict(), output: z.object({ placements: z.array(placementSchema) }) },
  board_move: { input: placementSchema.strict(), output: placementSchema },
});
const BOARD_CHANGED = "board-changed";
const STORAGE_KEY = "thread-columns";
type Placement = z.infer<typeof placementSchema>;

export default async function plugin(bb: BbPluginApi) {
  async function readPlacements(): Promise<Record<string, BoardColumn>> {
    return (await bb.storage.kv.get<Record<string, BoardColumn>>(STORAGE_KEY)) ?? {};
  }
  async function moveThread(threadId: string, column: BoardColumn): Promise<Placement> {
    const placements = await readPlacements();
    placements[threadId] = column;
    await bb.storage.kv.set(STORAGE_KEY, placements);
    bb.realtime.publish(BOARD_CHANGED, { threadId, column });
    return { threadId, column };
  }
  bb.rpc.register(rpcContract, {
    board_get: async ({ threadIds }) => {
      const placements = await readPlacements();
      return { placements: threadIds.map((threadId) => ({ threadId, column: placements[threadId] ?? "backlog" })) };
    },
    board_move: ({ threadId, column }) => moveThread(threadId, column),
  });
  bb.cli.register({
    name: "kanban-board",
    summary: "Move threads across the Kanban board",
    commands: [{ name: "move", summary: "Move a thread", usage: "bb kanban-board move <thread-id> <column>" }],
    async run(argv) {
      const [command, threadId, column] = argv;
      if (command !== "move" || !threadId || !column || !boardColumns.includes(column as BoardColumn)) {
        return { exitCode: 1, stderr: "Usage: bb kanban-board move <thread-id> <backlog|in_progress|review|done>" };
      }
      const placement = await moveThread(threadId, column as BoardColumn);
      return { exitCode: 0, stdout: placement.threadId + " -> " + placement.column };
    },
  });
}

