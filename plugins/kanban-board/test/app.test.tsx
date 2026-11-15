// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";

// Modules touching @get-bb/plugin-sdk/app bind the runtime at import time, so
// app.tsx may only be imported after loadPluginApp installed it.
const app = await loadPluginApp(() => import("../app"));
const board = app.navPanels[0]!;

function thread(
  id: string,
  partial: Partial<PluginSidebarThread> = {},
): PluginSidebarThread {
  const title = partial.title ?? `Заголовок ${id}`;
  return {
    id,
    projectId: "project-1",
    title,
    titleFallback: null,
    displayTitle: title,
    parentThreadId: null,
    lifecycleOwnerThreadId: null,
    parentNotifications: "auto",
    sourceThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "codex",
    status: "idle",
    runtimeStatus: "idle",
    queuedWork: "none",
    hasPendingInteraction: false,
    activity: {
      workflows: 0,
      backgroundAgents: 0,
      backgroundCommands: 0,
      planMode: 0,
    },
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    pinnedAt: null,
    pinSortKey: null,
    isArchived: false,
    archivedAt: null,
    href: `/projects/project-1/threads/${id}`,
    isHidden: false,
    environment: null,
    host: null,
    createdAt: 0,
    updatedAt: 0,
    lastReadAt: null,
    latestAttentionAt: 0,
    ...partial,
  };
}

const PARENT = thread("th_parent", { title: "Родитель", createdAt: 1 });
const CHILD_LATE = thread("th_child_late", {
  title: "Ребёнок поздний",
  parentThreadId: PARENT.id,
  createdAt: 30,
});
const CHILD_EARLY = thread("th_child_early", {
  title: "Ребёнок ранний",
  parentThreadId: PARENT.id,
  createdAt: 20,
  status: "active",
  runtimeStatus: "active",
  indicator: "runtime",
});
// Its parent is archived and therefore absent from the board.
const ORPHAN = thread("th_orphan", {
  title: "Сирота",
  parentThreadId: "th_archived",
  createdAt: 40,
});

type Placement = { threadId: string; column: string; pinned: boolean };

function mount(
  options: {
    threads?: readonly PluginSidebarThread[];
    placements?: Record<string, Placement["column"]>;
    moveImpl?: (input: { threadId: string; column: string }) => unknown;
  } = {},
): RenderedSlot {
  const placements = new Map<string, Placement["column"]>(
    Object.entries(options.placements ?? {}),
  );
  const threads = options.threads ?? [PARENT, CHILD_LATE, CHILD_EARLY, ORPHAN];
  return renderSlot(
    { component: board.component },
    { subPath: "" },
    {
      rpc: {
        board_get: ({ threadIds }: { threadIds: string[] }) => ({
          placements: threadIds.map((threadId) => ({
            threadId,
            column: placements.get(threadId) ?? "backlog",
            pinned: (placements.get(threadId) ?? "backlog") !== "backlog",
          })),
          autoMove: false,
        }),
        board_move: (input: { threadId: string; column: string }) => {
          placements.set(input.threadId, input.column);
          return options.moveImpl?.(input) ?? {
            threadId: input.threadId,
            column: input.column,
            pinned: input.column !== "backlog",
          };
        },
        board_auto_set: ({ enabled }: { enabled: boolean }) => ({ enabled }),
      } as never,
      sidebarThreads: {
        status: "ready",
        threads,
        projects: [],
        sections: [],
      },
    },
  );
}

function dataTransfer() {
  const store: Record<string, string> = {};
  return {
    store,
    setData: (type: string, value: string) => {
      store[type] = value;
    },
    getData: (type: string) => store[type] ?? "",
    effectAllowed: "move",
    dropEffect: "move",
  };
}

function card(slot: RenderedSlot, title: string): HTMLElement {
  return slot.getByText(title).closest("[data-board-card]") as HTMLElement;
}

function column(slot: RenderedSlot, name: string): HTMLElement {
  return slot.getByRole("region", { name });
}

function rpcCalls(slot: RenderedSlot, method: string) {
  return slot.inspection.rpcCalls.filter((call) => call.method === method);
}

afterEach(cleanup);

describe("board cards", () => {
  it("draws one card per top-level thread, with children nested inside", async () => {
    const slot = mount();
    await waitFor(() => expect(rpcCalls(slot, "board_get")).toHaveLength(1));

    const parentCard = await waitFor(() => {
      const element = card(slot, "Родитель");
      expect(element).not.toBeNull();
      return element;
    });
    expect(parentCard.dataset.boardCard).toBe(PARENT.id);
    expect(within(parentCard).getByText("Ребёнок ранний")).toBeTruthy();
    expect(within(parentCard).getByText("Ребёнок поздний")).toBeTruthy();

    const orphanCard = card(slot, "Сирота");
    expect(orphanCard.dataset.boardCard).toBe(ORPHAN.id);
    expect(orphanCard).not.toBe(parentCard);
  });

  it("orders nested children by creation time", async () => {
    const slot = mount();
    const parentCard = await waitFor(() => card(slot, "Родитель"));
    const rows = Array.from(
      parentCard.querySelectorAll<HTMLElement>("[data-board-subcard]"),
    ).map((row) => row.dataset.boardSubcard);
    expect(rows).toEqual([CHILD_EARLY.id, CHILD_LATE.id]);
  });

  it("keeps the thread counter counting every visible thread", async () => {
    const slot = mount();
    await waitFor(() => expect(rpcCalls(slot, "board_get")).toHaveLength(1));
    expect(slot.getByText("4 потоков")).toBeTruthy();
  });

  it("counts only cards, not nested subcards, in a column header", async () => {
    const slot = mount({ placements: { [CHILD_EARLY.id]: "in_progress" } });
    const backlog = await waitFor(() => column(slot, "В очереди"));
    // Parent and orphan are cards; the child is nested under the parent.
    expect(within(backlog).getByText("2")).toBeTruthy();
  });
});

describe("children list", () => {
  it("shows the child count and collapses and expands the list", async () => {
    const slot = mount();
    const toggle = await screen.findByRole("button", {
      name: /2 подкарточки/,
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Ребёнок ранний")).toBeTruthy();

    fireEvent.click(toggle);
    await waitFor(() =>
      expect(screen.queryByText("Ребёнок ранний")).toBeNull(),
    );
    expect(
      screen.getByRole("button", { name: /2 подкарточки/ }).getAttribute("aria-expanded"),
    ).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: /2 подкарточки/ }));
    expect(await screen.findByText("Ребёнок ранний")).toBeTruthy();
  });

  it("hides the count for a card without children", async () => {
    const slot = mount({ threads: [PARENT, ORPHAN] });
    await waitFor(() => expect(rpcCalls(slot, "board_get")).toHaveLength(1));
    expect(screen.queryByRole("button", { name: /подкарточк/ })).toBeNull();
    expect(slot.getByText("2 потоков")).toBeTruthy();
  });
});

describe("opening threads", () => {
  it("opens a nested thread on a row click and in a split from its button", async () => {
    const slot = mount();
    const parentCard = await waitFor(() => card(slot, "Родитель"));

    fireEvent.click(within(parentCard).getByRole("button", { name: "Ребёнок ранний" }));
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "toThread",
      threadId: CHILD_EARLY.id,
    });

    const row = within(parentCard).getByRole("button", { name: "Ребёнок поздний" });
    const subcard = row.closest("[data-board-subcard]") as HTMLElement;
    fireEvent.click(within(subcard).getByRole("button", { name: "Открыть поток" }));
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "toThread",
      threadId: CHILD_LATE.id,
      options: { split: true },
    });
  });
});

describe("drag and drop", () => {
  it("moves only the parent when its card is dragged", async () => {
    const slot = mount();
    const parentCard = await waitFor(() => card(slot, "Родитель"));
    const transfer = dataTransfer();

    fireEvent.dragStart(parentCard, { dataTransfer: transfer });
    expect(transfer.getData("text/thread-id")).toBe(PARENT.id);
    fireEvent.drop(column(slot, "Готово"), { dataTransfer: transfer });

    await waitFor(() =>
      expect(rpcCalls(slot, "board_move").map((call) => call.input)).toEqual([
        { threadId: PARENT.id, column: "done" },
      ]),
    );
  });

  it("moves a nested thread that is dragged out of its card", async () => {
    const slot = mount();
    const parentCard = await waitFor(() => card(slot, "Родитель"));
    const row = parentCard.querySelector<HTMLElement>(
      `[data-board-subcard="${CHILD_EARLY.id}"]`,
    )!;
    const transfer = dataTransfer();

    fireEvent.dragStart(row, { dataTransfer: transfer });
    expect(transfer.getData("text/thread-id")).toBe(CHILD_EARLY.id);
    fireEvent.drop(column(slot, "На проверке"), { dataTransfer: transfer });

    await waitFor(() =>
      expect(rpcCalls(slot, "board_move").map((call) => call.input)).toEqual([
        { threadId: CHILD_EARLY.id, column: "review" },
      ]),
    );
  });

  it("shows a column chip for a child placed in another column and keeps it nested", async () => {
    const slot = mount({ placements: { [CHILD_EARLY.id]: "review" } });
    const parentCard = await waitFor(() => card(slot, "Родитель"));
    const row = parentCard.querySelector<HTMLElement>(
      `[data-board-subcard="${CHILD_EARLY.id}"]`,
    )!;
    expect(within(row).getByText("На проверке")).toBeTruthy();
    // The child stays inside the parent card after its own placement changed.
    expect(card(slot, "Родитель")).toBe(parentCard);
  });

  it("omits the chip when a child shares its parent's column", async () => {
    const slot = mount();
    const parentCard = await waitFor(() => card(slot, "Родитель"));
    const row = parentCard.querySelector<HTMLElement>(
      `[data-board-subcard="${CHILD_EARLY.id}"]`,
    )!;
    expect(within(row).queryByText("В очереди")).toBeNull();
  });

  it("keeps the child nested after a failed move and reports the error", async () => {
    const slot = mount({
      moveImpl: () => {
        throw new Error("move failed");
      },
    });
    const parentCard = await waitFor(() => card(slot, "Родитель"));
    const row = parentCard.querySelector<HTMLElement>(
      `[data-board-subcard="${CHILD_LATE.id}"]`,
    )!;
    const transfer = dataTransfer();
    fireEvent.dragStart(row, { dataTransfer: transfer });
    fireEvent.drop(column(slot, "Готово"), { dataTransfer: transfer });

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("move failed"));
    expect(await card(slot, "Родитель")).toBe(parentCard);
    expect(
      screen.queryByText("Ребёнок поздний"),
    ).toBeTruthy();
  });
});
