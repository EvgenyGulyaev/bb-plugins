// @vitest-environment jsdom
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { ThreadBadge } from "../lib/model-badges";
import { DEFAULT_MARKS } from "../lib/model-marks";

const app = await loadPluginApp(() => import("../app"));
const rowMetadata = app.threadRowMetadata[0]!;
const segment = app.threadContextSegments[0]!;

afterEach(cleanup);

function thread(overrides: Partial<PluginSidebarThread> = {}): PluginSidebarThread {
  return {
    id: "t1",
    projectId: "p1",
    title: "Thread",
    titleFallback: null,
    displayTitle: "Thread",
    parentThreadId: null,
    lifecycleOwnerThreadId: null,
    parentNotifications: "auto",
    sourceThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "pi",
    status: "idle",
    runtimeStatus: "idle",
    queuedWork: "none",
    hasPendingInteraction: false,
    activity: "none",
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    pinnedAt: null,
    pinSortKey: null,
    isArchived: false,
    archivedAt: null,
    href: "/projects/p1/threads/t1",
    isHidden: false,
    environment: null,
    host: null,
    createdAt: 0,
    updatedAt: 0,
    lastReadAt: null,
    latestAttentionAt: 0,
    ...overrides,
  } as PluginSidebarThread;
}

function badge(overrides: Partial<ThreadBadge> = {}): ThreadBadge {
  return {
    providerId: "pi",
    model: "claude-sonnet-5-5",
    family: "claude",
    mark: DEFAULT_MARKS.claude,
    ...overrides,
  };
}

type RowProps = { thread: PluginSidebarThread; data: Record<string, ThreadBadge | null> | undefined };

function renderBadge(props: RowProps) {
  return renderSlot(
    { component: rowMetadata.component as never },
    props as never,
    {},
  );
}

describe("threadRowMetadata — марка модели", () => {
  it("рисует марку семейства для pi-треда", async () => {
    const slot = renderBadge({ thread: thread(), data: { t1: badge() } });
    expect(await slot.findByLabelText("claude-sonnet-5-5")).toBeTruthy();
    // tooltip с полным id не должен зависеть от host experimental_Icon
    expect(slot.getByTitle("claude-sonnet-5-5")).toBeTruthy();
  });

  it("рисует текстовую марку х5", async () => {
    const slot = renderBadge({
      thread: thread({ id: "t2", providerId: "pi" }),
      data: { t2: badge({ model: "x5-airun-large", family: "x5", mark: DEFAULT_MARKS.x5 }) },
    });
    expect(await slot.findByText("х5")).toBeTruthy();
  });

  it("null для не-pi, без данных и с небезопасным SVG", () => {
    for (const props of [
      { thread: thread({ providerId: "claude-code" }), data: { t1: badge() } },
      { thread: thread(), data: undefined },
      { thread: thread(), data: { t1: null } },
      {
        thread: thread(),
        data: { t1: badge({ mark: { kind: "svg", value: "<svg><script>alert(1)</script></svg>" } }) },
      },
    ] satisfies RowProps[]) {
      const slot = renderBadge(props);
      expect(slot.container.innerHTML).toBe("");
      slot.lifecycle.unmount();
    }
  });
});

describe("useData — батч только по pi-тредам", () => {
  it("запрашивает ключи pi-тредов одним keyed RPC", async () => {
    const useData = rowMetadata.useData as unknown as (input: {
      threads: readonly PluginSidebarThread[];
    }) => Record<string, ThreadBadge | null> | undefined;
    function Probe() {
      const data = useData({
        threads: [thread({ id: "t1" }), thread({ id: "t2", providerId: "claude-code" })],
      });
      return <pre data-testid="data">{JSON.stringify(data ?? null)}</pre>;
    }
    const slot = renderSlot({ component: Probe }, {}, {
      rpc: { model_badges_for: ({ keys }: { keys: string[] }) => Object.fromEntries(keys.map((key) => [key, badge()])) } as never,
    });
    await slot.findByTestId("data");
    expect(slot.inspection.rpcCalls.map((call) => call.method)).toEqual(["model_badges_for"]);
    expect(slot.inspection.rpcCalls[0]!.input).toEqual({ keys: ["t1"] });
  });
});

describe("threadContextSegment — марка и имя модели", () => {
  it("показывает марку и полное имя модели в открытом pi-треде", async () => {
    const slot = renderSlot(
      { component: segment.summary as never },
      { threadId: "t1", projectId: "p1", environment: null, segments: [], isExpanded: false, onToggle: () => {} } as never,
      { rpc: { model_badges_for: ({ keys }: { keys: string[] }) => Object.fromEntries(keys.map((key) => [key, badge()])) } as never },
    );
    expect(await slot.findByText("claude-sonnet-5-5")).toBeTruthy();
  });
});
