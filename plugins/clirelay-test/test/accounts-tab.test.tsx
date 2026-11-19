// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { RenderedSlot, RenderSlotOptions } from "@get-bb/plugin-sdk/testing/app";
import type { RelayAccount } from "../lib/relay-accounts";

// Модули, трогающие @get-bb/plugin-sdk/app, биндят рантайм при импорте —
// app.tsx импортируем только после установки рантайма loadPluginApp.
const app = await loadPluginApp(() => import("../app"));
const panel = app.navPanels[0]!;

const provider = { id: "relay", name: "relay", baseUrl: "http://relay:4010/v1", api: "openai-completions", apiKeySet: true, models: [], disabled: [] };

const accounts = [
  {
    auth_index: "kimi:1",
    provider: "kimi",
    email: "k@example.com",
    disabled: false,
    quotas: [{ quota_key: "m_quota.code_5h", percent: 63 }],
  },
  {
    auth_index: "claude:1",
    provider: "claude",
    email: "c@example.com",
    disabled: false,
    quotas: [{ quota_key: "claude_seven_day", percent: 12 }],
  },
];

const KEY = (authIndex: string) => `http://relay:4010|${authIndex}`;

function mount(options: {
  rings?: { selected: string[]; size: number; perRow: number };
  accountItems?: RelayAccount[];
  rpc?: Record<string, (input: unknown) => unknown>;
} = {}): { slot: RenderedSlot; calls: (method: string) => Array<{ method: string; input: unknown }> } {
  const rings = options.rings ?? { selected: [], size: 40, perRow: 1 };
  const slot = renderSlot({ component: panel.component }, { subPath: "" }, {
    rpc: {
      providers_list: () => ({ providers: [provider] }),
      relay_accounts: () => ({ configured: true, items: options.accountItems ?? accounts }),
      rings_state: () => rings,
      rings_toggle: (input) => {
        const { key, on } = input as { key: string; on: boolean };
        return { ...rings, selected: on ? [...rings.selected, key] : rings.selected.filter((entry) => entry !== key) };
      },
      rings_size: (input) => ({ ...rings, size: (input as { size: number }).size }),
      rings_per_row: (input) => ({ ...rings, perRow: (input as { perRow: number }).perRow }),
      ...options.rpc,
    } as never,
  } as RenderSlotOptions);
  return {
    slot,
    calls: (method) => slot.inspection.rpcCalls.filter((call) => call.method === method) as Array<{ method: string; input: unknown }>,
  };
}

afterEach(cleanup);

describe("accounts tab rings controls", () => {
  it("draws a ring checkbox on every account card in both columns", async () => {
    mount();
    const rings = await screen.findAllByRole("checkbox", { name: /^Кольцо в рейле/ });
    expect(rings).toHaveLength(2);
    expect(screen.getByRole("checkbox", { name: "Кольцо в рейле k@example.com" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Кольцо в рейле c@example.com" })).toBeTruthy();
  });

  it("checks the box for the accounts selected in rings_state", async () => {
    mount({ rings: { selected: [KEY("kimi:1")], size: 40, perRow: 1 } });
    const kimiBox = await screen.findByRole("checkbox", { name: "Кольцо в рейле k@example.com" }) as HTMLElement;
    await waitFor(() => expect(kimiBox.getAttribute("data-state")).toBe("checked"));
    expect(
      (screen.getByRole("checkbox", { name: "Кольцо в рейле c@example.com" }) as HTMLElement).getAttribute("data-state"),
    ).toBe("unchecked");
  });

  it("writes the toggle to rings_toggle with the origin|auth_index key", async () => {
    const { calls } = mount();
    const box = await screen.findByRole("checkbox", { name: "Кольцо в рейле k@example.com" });
    fireEvent.click(box);
    await waitFor(() => expect(calls("rings_toggle")).toEqual([
      { method: "rings_toggle", input: { key: KEY("kimi:1"), on: true } },
    ]));
  });

  it("removes a ring when its box is unchecked", async () => {
    const { calls } = mount({ rings: { selected: [KEY("kimi:1"), KEY("claude:1")], size: 40, perRow: 1 } });
    const box = await screen.findByRole("checkbox", { name: "Кольцо в рейле k@example.com" });
    await waitFor(() => expect((box as HTMLElement).getAttribute("data-state")).toBe("checked"));
    fireEvent.click(box);
    await waitFor(() => expect(calls("rings_toggle")).toEqual([
      { method: "rings_toggle", input: { key: KEY("kimi:1"), on: false } },
    ]));
  });

  it("carries the rubric: size slider and a 1..4 per-row input in the toolbar", async () => {
    mount({ rings: { selected: [], size: 48, perRow: 2 } });
    const slider = await screen.findByRole("slider", { name: "Размер колец" });
    expect((slider as HTMLInputElement).value).toBe("48");
    expect((slider as HTMLInputElement).min).toBe("24");
    expect((slider as HTMLInputElement).max).toBe("64");
    expect((slider as HTMLInputElement).step).toBe("2");
    const perRow = screen.getByRole("spinbutton", { name: "Колец в строке" }) as HTMLInputElement;
    expect(perRow.value).toBe("2");
    expect(perRow.min).toBe("1");
    expect(perRow.max).toBe("4");
  });

  it("debounces the slider into rings_size", async () => {
    const { calls } = mount();
    const slider = await screen.findByRole("slider", { name: "Размер колец" });
    fireEvent.change(slider, { target: { value: "52" } });
    fireEvent.change(slider, { target: { value: "56" } });
    await waitFor(() => expect(calls("rings_size")).toEqual([
      { method: "rings_size", input: { size: 56 } },
    ]));
  });

  it("flushes a pending slider change when the panel closes early", async () => {
    const { slot, calls } = mount();
    const slider = await screen.findByRole("slider", { name: "Размер колец" });
    fireEvent.change(slider, { target: { value: "58" } });
    // панель закрыли раньше, чем истёк debounce
    slot.unmount();
    await waitFor(() => expect(calls("rings_size")).toEqual([
      { method: "rings_size", input: { size: 58 } },
    ]));
  });

  it("writes the per-row input into rings_per_row", async () => {
    const { calls } = mount();
    const perRow = await screen.findByRole("spinbutton", { name: "Колец в строке" });
    fireEvent.change(perRow, { target: { value: "3" } });
    await waitFor(() => expect(calls("rings_per_row")).toEqual([
      { method: "rings_per_row", input: { perRow: 3 } },
    ]));
  });
});

describe("account costs and reset fallback", () => {
  const account = (partial: Partial<RelayAccount> & { auth_index: string }): RelayAccount => ({
    provider: "claude",
    disabled: false,
    quotas: [],
    ...partial,
  });

  it("shows a positive quota cost and hides zero or missing costs", async () => {
    mount({ accountItems: [
      account({ auth_index: "positive", email: "positive@example.com", quotas: [{ quota_key: "five_hour", percent: 50, used_cost_usd: 34.1 }] }),
      account({ auth_index: "zero", email: "zero@example.com", quotas: [{ quota_key: "five_hour", percent: 100, used_cost_usd: 0 }] }),
      account({ auth_index: "missing", email: "missing@example.com", quotas: [{ quota_key: "five_hour", percent: 100 }] }),
    ] });
    const positive = (await screen.findByText("positive@example.com")).closest("article")!;
    const zero = screen.getByText("zero@example.com").closest("article")!;
    const missing = screen.getByText("missing@example.com").closest("article")!;
    expect(within(positive).getByText("$34.10")).toBeTruthy();
    expect(within(zero).queryByText(/^\$/)).toBeNull();
    expect(within(missing).queryByText(/^\$/)).toBeNull();
  });

  it("distinguishes an unstarted window, an unknown reset and a countdown", async () => {
    mount({ accountItems: [
      account({ auth_index: "full", email: "full@example.com", quotas: [{ quota_key: "five_hour", percent: 100, window_seconds: 18000 }] }),
      account({ auth_index: "started", email: "started@example.com", quotas: [{ quota_key: "five_hour", percent: 63, window_seconds: 18000 }] }),
      account({ auth_index: "reset", email: "reset@example.com", quotas: [{ quota_key: "five_hour", percent: 63, window_seconds: 18000, reset_at: new Date(Date.now() + 2 * 3600_000).toISOString() }] }),
    ] });
    const unstarted = await screen.findByText("окно не начато");
    const unknown = screen.getByText("сброс неизвестен");
    const expectedTitle = "relay не сообщает сброс, пока окно не начато; длина окна 5 ч";
    expect(unstarted.getAttribute("title")).toBe(expectedTitle);
    expect(unknown.getAttribute("title")).toBe(expectedTitle);
    expect(screen.getByText(/↺/)).toBeTruthy();
    expect(screen.getByText("reset@example.com").closest("article")!.textContent).not.toContain("сброс неизвестен");
  });

  it("shows the seven-day cost chip and its detailed title", async () => {
    mount({ accountItems: [account({
      auth_index: "costs",
      email: "costs@example.com",
      quotas: [{ quota_key: "five_hour", percent: 100 }],
      usage: { cost_total: 432.83, cost_total_7d: 58.28, cycle_cost_total: 34.1, cycle_known: true, request_total_7d: 437 },
    })] });
    const chip = await screen.findByText("$58.28 за 7 дн");
    expect(chip.getAttribute("title")).toBe("Всего: $432.83 · цикл: $34.10 · запросов за 7 дн: 437");
  });

  it("omits zero total and cycle costs from the chip title", async () => {
    mount({ accountItems: [account({
      auth_index: "zero-details",
      email: "zero-details@example.com",
      quotas: [{ quota_key: "five_hour", percent: 100 }],
      usage: { cost_total: 0, cost_total_7d: 2, cycle_cost_total: 0, cycle_known: true, request_total_7d: 4 },
    })] });
    const chip = await screen.findByText("$2.00 за 7 дн");
    expect(chip.getAttribute("title")).toBe("запросов за 7 дн: 4");
    expect(chip.getAttribute("title")).not.toContain("Всего: $0.00");
    expect(chip.getAttribute("title")).not.toContain("цикл: $0.00");
  });

  it("marks an unknown cycle and hides the chip for missing or zero usage", async () => {
    mount({ accountItems: [
      account({ auth_index: "unknown", email: "unknown@example.com", quotas: [{ quota_key: "five_hour", percent: 100 }], usage: { cost_total: 10, cost_total_7d: 2, cycle_cost_total: 3, cycle_known: false, request_total_7d: 4 } }),
      account({ auth_index: "none", email: "none@example.com", quotas: [{ quota_key: "five_hour", percent: 100 }] }),
      account({ auth_index: "zeros", email: "zeros@example.com", quotas: [{ quota_key: "five_hour", percent: 100 }], usage: { cost_total: 0, cost_total_7d: 0, cycle_cost_total: 0, request_total_7d: 0 } }),
    ] });
    const chip = await screen.findByText("$2.00 за 7 дн");
    expect(chip.getAttribute("title")).toBe("Всего: $10.00 · цикл: неизвестен · запросов за 7 дн: 4");
    expect(screen.getByText("none@example.com").closest("article")!.textContent).not.toContain("за 7 дн");
    expect(screen.getByText("zeros@example.com").closest("article")!.textContent).not.toContain("за 7 дн");
  });
});

describe("rail overlay", () => {
  it("registers a content script and an app overlay", () => {
    expect(app.contentScripts.map((script) => script.id)).toContain("relay-rings-anchor");
    expect(app.appOverlays.map((overlay) => overlay.id)).toContain("relay-rings");
  });

  it("draws the selected rings into the rail anchor and follows the realtime signal", async () => {
    const rail = document.createElement("nav");
    rail.setAttribute("data-sidebar-navigation-placement", "rail");
    const footer = document.createElement("div");
    footer.innerHTML = '<button><svg data-icon="Settings"></svg></button>';
    document.body.append(footer, rail);

    const overlay = app.appOverlays[0]!;
    const slot = renderSlot({ component: overlay.component }, {}, {
      rpc: {
        rings_state: () => ({ selected: [KEY("kimi:1")], size: 40, perRow: 1 }),
        providers_list: () => ({ providers: [provider] }),
        relay_accounts: () => ({ configured: true, items: accounts }),
      } as never,
    } as RenderSlotOptions);

    const { mountRingsRail } = await import("../lib/rings-rail");
    const dispose = mountRingsRail(document, "clirelay-test");
    try {
      await waitFor(() => expect(document.querySelectorAll(".relay-ring-button")).toHaveLength(1));
      expect(document.querySelector(".relay-ring-button")?.getAttribute("data-ring-key")).toBe("kimi");

      const before = slot.inspection.rpcCalls.filter((call) => call.method === "relay_accounts").length;
      await slot.behavior.emitRealtime("relay-rings-changed", {});
      await waitFor(() =>
        expect(slot.inspection.rpcCalls.filter((call) => call.method === "relay_accounts").length).toBeGreaterThan(before),
      );
    } finally {
      dispose();
      rail.remove();
      footer.remove();
      slot.unmount();
    }
  });
});
