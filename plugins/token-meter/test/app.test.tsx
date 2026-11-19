// @vitest-environment jsdom
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import type {
  ExperimentalMessageMetadataProps,
  ExperimentalThreadContextSegmentProps,
} from "@get-bb/plugin-sdk/app";
import type { ThreadUsage, TurnUsage } from "../lib/contract.js";

const app = await loadPluginApp(() => import("../app"));
const metadata = app.messageMetadata.find((row) => row.id === "token-meter")!;
const context = app.threadContextSegments.find((row) => row.id === "token-meter")!;
const THREAD = "thr_1";
const TURN = "turn-1";
const KEY = `${THREAD}:${TURN}`;
const slots: RenderedSlot[] = [];

function turn(patch: Partial<TurnUsage> = {}): TurnUsage {
  return {
    threadId: THREAD,
    turnId: TURN,
    input: 1_200,
    cached: 265_000,
    cacheRead: 260_000,
    cacheWrite: 5_000,
    output: 740,
    reasoning: 120,
    total: 2_060,
    durationMs: 12_500,
    tokPerSec: 59.2,
    at: 1_000,
    ...patch,
  };
}

function summary(patch: Partial<ThreadUsage> = {}): ThreadUsage {
  return { threadId: THREAD, total: 531_000, turns: 4, averageTokPerSec: 40, modelContextWindow: 1_000_000, ...patch };
}

function message(patch: Partial<ExperimentalMessageMetadataProps["message"]> = {}): ExperimentalMessageMetadataProps["message"] {
  return { id: "message-1", threadId: THREAD, turnId: TURN, role: "assistant", createdAt: 100, ...patch } as ExperimentalMessageMetadataProps["message"];
}

function contextProps(): ExperimentalThreadContextSegmentProps {
  return {
    threadId: THREAD,
    projectId: "project-1",
    environment: null,
    segments: [{ key: "token-meter/token-meter", pluginId: "token-meter" }],
    isExpanded: false,
    onToggle: () => {},
  };
}

function mountMessage(props: ExperimentalMessageMetadataProps["message"], usage: TurnUsage | null) {
  const slot = renderSlot({ component: metadata.component }, { message: props }, {
    pluginId: "token-meter",
    rpc: {
      turn_usage: ({ keys }: { keys: string[] }) => Object.fromEntries(keys.map((key) => [key, key === KEY ? usage : null])),
      thread_usage: () => null,
    } as never,
  });
  slots.push(slot);
  return slot;
}

function mountContext(value: ThreadUsage | null) {
  const slot = renderSlot({ component: context.summary }, contextProps(), {
    pluginId: "token-meter",
    rpc: {
      turn_usage: ({ keys }: { keys: string[] }) => Object.fromEntries(keys.map((key) => [key, null])),
      thread_usage: () => value,
    } as never,
  });
  slots.push(slot);
  return slot;
}

afterEach(() => {
  for (const slot of slots.splice(0)) slot.unmount();
  cleanup();
});

describe("messageMetadata", () => {
  it("регистрируется в actionRow", () => {
    expect(metadata.placement).toBe("actionRow");
  });

  it("при записи рисует бейдж и полный title", async () => {
    const slot = mountMessage(message(), turn());
    expect(await slot.findByText("↑1.2k ↓740 · cache 265k · 59.2 ток/с")).toBeTruthy();
    const badge = slot.container.querySelector(".token-meter-badge");
    expect(badge?.getAttribute("title")).toContain("Reasoning: 120");
    expect(badge?.getAttribute("title")).toContain("Кеш чтение: 260000");
    expect(badge?.getAttribute("title")).toContain("Кеш запись: 5000");
    expect(badge?.getAttribute("title")).toContain("Длительность: 12.5 с");
  });

  it("без записи → null", async () => {
    const slot = mountMessage(message(), null);
    await waitFor(() => expect(slot.inspection.rpcCalls.filter((call) => call.method === "turn_usage")).toHaveLength(1));
    await act(async () => {});
    expect(slot.container.childNodes).toHaveLength(0);
  });

  it.each([
    message({ role: "user", initiator: "user", turnId: TURN }),
    message({ turnId: null }),
  ])("user или turnId=null → null и RPC не вызывается", async (props) => {
    const rpc = vi.fn(() => ({}));
    const slot = renderSlot({ component: metadata.component }, { message: props }, {
      rpc: { turn_usage: rpc, thread_usage: () => null } as never,
    });
    slots.push(slot);
    await act(async () => {});
    expect(slot.container.childNodes).toHaveLength(0);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("из двух assistant-сообщений хода бейдж остаётся только у последнего по createdAt", async () => {
    const first = mountMessage(message({ id: "message-1", createdAt: 100 }), turn());
    await first.findByText(/↑1.2k/);
    const second = mountMessage(message({ id: "message-2", createdAt: 200 }), turn());
    await second.findByText(/↑1.2k/);
    await waitFor(() => expect(first.container.childNodes).toHaveLength(0));
    expect(second.container.querySelectorAll(".token-meter-badge")).toHaveLength(1);
  });

  it("realtime token-meter-changed обновляет keyed query", async () => {
    let current = turn({ output: 10 });
    const slot = renderSlot({ component: metadata.component }, { message: message() }, {
      pluginId: "token-meter",
      rpc: {
        turn_usage: ({ keys }: { keys: string[] }) => Object.fromEntries(keys.map((key) => [key, current])),
        thread_usage: () => null,
      } as never,
    });
    slots.push(slot);
    await waitFor(() => expect(slot.inspection.rpcCalls.filter((call) => call.method === "turn_usage")).toHaveLength(1));
    await slot.findByText(/↓10/);
    current = turn({ output: 20 });
    await slot.behavior.emitRealtime("token-meter-changed", { threadId: THREAD });
    await slot.findByText(/↓20/);
  });
});

describe("threadContextSegment", () => {
  it("рисует сводку, без данных → null", async () => {
    const withData = mountContext(summary());
    expect(await withData.findByText("Σ 531k токенов · ~40 ток/с")).toBeTruthy();
    const withoutData = mountContext(null);
    await waitFor(() => expect(withoutData.inspection.rpcCalls.filter((call) => call.method === "thread_usage")).toHaveLength(1));
    await act(async () => {});
    expect(withoutData.container.childNodes).toHaveLength(0);
  });

  it("realtime token-meter-changed обновляет сводку", async () => {
    let current = summary({ total: 100 });
    const slot = renderSlot({ component: context.summary }, contextProps(), {
      rpc: {
        turn_usage: () => ({}),
        thread_usage: () => current,
      } as never,
    });
    slots.push(slot);
    await slot.findByText(/Σ 100 токенов/);
    current = summary({ total: 200 });
    await slot.behavior.emitRealtime("token-meter-changed", { threadId: THREAD });
    await slot.findByText(/Σ 200 токенов/);
  });
});
