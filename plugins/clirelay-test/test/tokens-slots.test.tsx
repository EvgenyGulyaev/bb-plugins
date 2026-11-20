// @vitest-environment jsdom
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import type {
  ExperimentalMessageMetadataProps,
  ExperimentalThreadContextSegmentProps,
} from "@get-bb/plugin-sdk/app";
import type { ThreadUsage, TurnUsage } from "../lib/tokens/contract";
import { DEFAULT_TOKENS_DISPLAY, type TokensDisplay } from "../lib/tokens/display";
import { TokensMessageBadge } from "../components/tokens-slots";

const app = await loadPluginApp(() => import("../app"));
const metadata = app.messageMetadata.find((row) => row.id === "tokens")!;
const context = app.threadContextSegments.find((row) => row.id === "tokens")!;
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
    turnDurationMs: 20_000,
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
    segments: [{ key: "tokens/tokens", pluginId: "clirelay-test" }],
    isExpanded: false,
    onToggle: () => {},
  };
}

function mountMessage(
  props: ExperimentalMessageMetadataProps["message"],
  usage: TurnUsage | null,
  display: TokensDisplay = DEFAULT_TOKENS_DISPLAY,
) {
  const slot = renderSlot({ component: metadata.component }, { message: props }, {
    pluginId: "clirelay-test",
    rpc: {
      turn_usage: ({ keys }: { keys: string[] }) => Object.fromEntries(keys.map((key) => [key, key === KEY ? usage : null])),
      thread_usage: () => null,
      tokens_display_get: () => display,
    } as never,
  });
  slots.push(slot);
  return slot;
}

function mountContext(value: ThreadUsage | null, display: TokensDisplay = DEFAULT_TOKENS_DISPLAY) {
  const slot = renderSlot({ component: context.summary }, contextProps(), {
    pluginId: "clirelay-test",
    rpc: {
      turn_usage: ({ keys }: { keys: string[] }) => Object.fromEntries(keys.map((key) => [key, null])),
      thread_usage: () => value,
      tokens_display_get: () => display,
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
    expect(await slot.findByText("↑1.2k ↓740 · cache 265k · 59.2 ток/с (эфф.)")).toBeTruthy();
    const badge = slot.container.querySelector(".api-tokens-badge");
    expect(badge?.getAttribute("title")).toContain("Reasoning: 120");
    expect(badge?.getAttribute("title")).toContain("Кеш чтение: 260000");
    expect(badge?.getAttribute("title")).toContain("Кеш запись: 5000");
    expect(badge?.getAttribute("title")).toContain("Последний вызов: 12.5 с · Весь ход: 20 с");
    expect(badge?.getAttribute("title")).toContain("Эффективная скорость последнего вызова: 59.2 ток/с — выход ÷ время от конца последнего инструмента до конца хода; включает ожидание первого токена");
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
    expect(second.container.querySelectorAll(".api-tokens-badge")).toHaveLength(1);
  });

  it("инвалидация тега thread:<id> обновляет keyed query, чужой тег — нет", async () => {
    let current = turn({ output: 10 });
    const slot = renderSlot({ component: metadata.component }, { message: message() }, {
      pluginId: "clirelay-test",
      rpc: {
        turn_usage: ({ keys }: { keys: string[] }) => Object.fromEntries(keys.map((key) => [key, current])),
        thread_usage: () => null,
        tokens_display_get: () => DEFAULT_TOKENS_DISPLAY,
      } as never,
    });
    slots.push(slot);
    const calls = () => slot.inspection.rpcCalls.filter((call) => call.method === "turn_usage").length;
    await waitFor(() => expect(calls()).toBe(1));
    await slot.findByText(/↓10/);
    current = turn({ output: 15 });
    await slot.behavior.experimental_invalidateRpc(["thread:thr_other"]);
    await act(async () => {});
    expect(calls()).toBe(1);
    current = turn({ output: 20 });
    await slot.behavior.experimental_invalidateRpc([`thread:${THREAD}`]);
    await slot.findByText(/↓20/);
    expect(calls()).toBe(2);
  });

  it("равные createdAt → бейдж у большего messageId", async () => {
    const first = mountMessage(message({ id: "message-2", createdAt: 100 }), turn());
    await first.findByText(/↑1.2k/);
    const second = mountMessage(message({ id: "message-1", createdAt: 100 }), turn());
    await act(async () => {});
    expect(second.container.childNodes).toHaveLength(0);
    expect(first.container.querySelectorAll(".api-tokens-badge")).toHaveLength(1);
  });
});

describe("threadContextSegment", () => {
  it("рисует сводку, без данных → null", async () => {
    const withData = mountContext(summary());
    expect(await withData.findByText("Σ 531k токенов · ~40 ток/с (эфф.)")).toBeTruthy();
    const withoutData = mountContext(null);
    await waitFor(() => expect(withoutData.inspection.rpcCalls.filter((call) => call.method === "thread_usage")).toHaveLength(1));
    await act(async () => {});
    expect(withoutData.container.childNodes).toHaveLength(0);
  });

  it("инвалидация тега обновляет сводку, чужой тег — нет", async () => {
    let current = summary({ total: 100 });
    const slot = renderSlot({ component: context.summary }, contextProps(), {
      rpc: {
        turn_usage: () => ({}),
        thread_usage: () => current,
        tokens_display_get: () => DEFAULT_TOKENS_DISPLAY,
      } as never,
    });
    slots.push(slot);
    const calls = () => slot.inspection.rpcCalls.filter((call) => call.method === "thread_usage").length;
    await slot.findByText(/Σ 100 токенов/);
    expect(calls()).toBe(1);
    await slot.behavior.experimental_invalidateRpc(["thread:thr_other"]);
    await act(async () => {});
    expect(calls()).toBe(1);
    current = summary({ total: 200 });
    await slot.behavior.experimental_invalidateRpc([`thread:${THREAD}`]);
    await slot.findByText(/Σ 200 токенов/);
  });
});

describe("настройки отображения", () => {
  const withBadge = (patch: Partial<TokensDisplay["badge"]>): TokensDisplay => ({
    ...DEFAULT_TOKENS_DISPLAY,
    badge: { ...DEFAULT_TOKENS_DISPLAY.badge, ...patch },
  });

  it("показ выключен → null, turn_usage не вызывается, сообщение не регистрируется", async () => {
    const slot = mountMessage(message(), turn(), withBadge({ enabled: false }));
    await act(async () => {});
    expect(slot.container.childNodes).toHaveLength(0);
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "turn_usage")).toHaveLength(0);
  });

  it("поля бейджа из настроек: reasoning и модель; все сняты → null без пустого span", async () => {
    const slot = mountMessage(message(), turn({ model: "test-model" }), withBadge({
      fields: { ...DEFAULT_TOKENS_DISPLAY.badge.fields, reasoning: true, model: true },
    }));
    const badge = await slot.findByText(/reasoning 120/);
    expect(badge.textContent).toContain("test-model");

    const empty = mountMessage(message(), turn(), withBadge({
      fields: { input: false, output: false, cache: false, reasoning: false, speed: false, model: false },
    }));
    await waitFor(() => expect(empty.inspection.rpcCalls.filter((call) => call.method === "turn_usage")).toHaveLength(1));
    await act(async () => {});
    expect(empty.container.childNodes).toHaveLength(0);
  });

  it("настройки ещё не пришли → null и turn_usage не вызывается", async () => {
    const slot = renderSlot({ component: metadata.component }, { message: message() }, {
      pluginId: "clirelay-test",
      rpc: {
        turn_usage: ({ keys }: { keys: string[] }) => Object.fromEntries(keys.map((key) => [key, turn()])),
        thread_usage: () => null,
        tokens_display_get: () => new Promise(() => {}),
      } as never,
    });
    slots.push(slot);
    await act(async () => {});
    expect(slot.container.childNodes).toHaveLength(0);
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "turn_usage")).toHaveLength(0);
  });

  it("строка треда выключена → summary null, thread_usage не вызывается", async () => {
    const slot = mountContext(summary(), {
      ...DEFAULT_TOKENS_DISPLAY,
      thread: { ...DEFAULT_TOKENS_DISPLAY.thread, enabled: false },
    });
    await act(async () => {});
    expect(slot.container.childNodes).toHaveLength(0);
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "thread_usage")).toHaveLength(0);
  });

  it("инвалидация tokens-display применяется без ремаунта", async () => {
    let current = DEFAULT_TOKENS_DISPLAY;
    const slot = renderSlot({ component: metadata.component }, { message: message() }, {
      pluginId: "clirelay-test",
      rpc: {
        turn_usage: ({ keys }: { keys: string[] }) => Object.fromEntries(keys.map((key) => [key, turn()])),
        thread_usage: () => null,
        tokens_display_get: () => current,
      } as never,
    });
    slots.push(slot);
    await slot.findByText("↑1.2k ↓740 · cache 265k · 59.2 ток/с (эфф.)");
    current = withBadge({ fields: { ...DEFAULT_TOKENS_DISPLAY.badge.fields, cache: false, speed: false } });
    await slot.behavior.experimental_invalidateRpc(["tokens-display"]);
    await slot.findByText("↑1.2k ↓740");
  });

  it("useVisible сегмента зарегистрирован", () => {
    expect(typeof (context as { useVisible?: unknown }).useVisible).toBe("function");
  });

  it("два бейджа в одном окне → один запрос настроек", async () => {
    const pair = () => (
      <div>
        <TokensMessageBadge message={message({ id: "message-1", createdAt: 100 })} />
        <TokensMessageBadge message={message({ id: "message-2", createdAt: 200 })} />
      </div>
    );
    const slot = renderSlot({ component: pair }, {}, {
      pluginId: "clirelay-test",
      rpc: {
        turn_usage: ({ keys }: { keys: string[] }) => Object.fromEntries(keys.map((key) => [key, turn()])),
        thread_usage: () => null,
        tokens_display_get: () => DEFAULT_TOKENS_DISPLAY,
      } as never,
    });
    slots.push(slot);
    await slot.findAllByText(/↑1.2k/);
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "tokens_display_get")).toHaveLength(1);
  });
});
