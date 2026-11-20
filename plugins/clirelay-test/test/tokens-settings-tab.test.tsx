// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { DEFAULT_TOKENS_DISPLAY, applyTokensDisplayPatch, type TokensDisplay } from "../lib/tokens/display";

// app.tsx биндит рантайм при импорте — грузим его только после loadPluginApp.
const app = await loadPluginApp(() => import("../app"));
const panel = app.navPanels[0]!;

const slots: RenderedSlot[] = [];

function mount(options: { display?: TokensDisplay; failSet?: boolean } = {}) {
  let display = options.display ?? DEFAULT_TOKENS_DISPLAY;
  const slot = renderSlot({ component: panel.component }, { subPath: "" }, {
    rpc: {
      providers_list: () => ({ providers: [] }),
      rings_state: () => ({ selected: [], size: 40, perRow: 1 }),
      relay_accounts: () => ({ configured: false, items: [] }),
      tokens_display_get: () => display,
      tokens_display_set: (input: unknown) => {
        if (options.failSet) throw new Error("kv упал");
        display = applyTokensDisplayPatch(display, input as never);
        return display;
      },
    } as never,
  });
  slots.push(slot);
  return {
    slot,
    sets: () => slot.inspection.rpcCalls.filter((call) => call.method === "tokens_display_set"),
  };
}

async function openSettings(options: { display?: TokensDisplay; failSet?: boolean } = {}) {
  const mounted = mount(options);
  fireEvent.click(await screen.findByRole("tab", { name: /Настройки/ }));
  await screen.findByText("Строка треда");
  return mounted;
}

afterEach(() => {
  for (const slot of slots.splice(0)) slot.unmount();
  cleanup();
});

describe("вкладка «Настройки»", () => {
  it("рендерится, не дожидаясь providers_list", async () => {
    const slot = renderSlot({ component: panel.component }, { subPath: "" }, {
      rpc: {
        providers_list: () => new Promise(() => {}),
        rings_state: () => ({ selected: [], size: 40, perRow: 1 }),
        tokens_display_get: () => DEFAULT_TOKENS_DISPLAY,
      } as never,
    });
    slots.push(slot);
    fireEvent.click(await screen.findByRole("tab", { name: /Настройки/ }));
    expect(await screen.findByText("Строка треда")).toBeTruthy();
    expect(screen.getByText("Бейдж у ответа")).toBeTruthy();
  });

  it("галочки отражают дефолты", async () => {
    await openSettings();
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Строка треда: Σ токенов" })).toBeTruthy());
    const checked = (name: string) =>
      screen.getByRole("checkbox", { name }).getAttribute("data-state") === "checked";
    expect(checked("Строка треда: Σ токенов")).toBe(true);
    expect(checked("Строка треда: число ходов")).toBe(false);
    expect(checked("Бейдж у ответа: кэш")).toBe(true);
    expect(checked("Бейдж у ответа: reasoning")).toBe(false);
  });

  it("клик по галочке пишет патч и сразу меняет пример", async () => {
    const { sets } = await openSettings();
    const reasoning = await screen.findByRole("checkbox", { name: "Бейдж у ответа: reasoning" });
    fireEvent.click(reasoning);
    await waitFor(() => expect(sets()).toHaveLength(1));
    expect(sets()[0]!.input).toEqual({ target: "badgeField", field: "reasoning", on: true });
    expect(await screen.findByText(/reasoning 120/)).toBeTruthy();
  });

  it("тумблер секции выключает галочки и показывает «Выключено»", async () => {
    const { sets } = await openSettings();
    const toggle = await screen.findByRole("switch", { name: "Показывать бейдж у ответа" });
    fireEvent.click(toggle);
    await waitFor(() => expect(sets()).toHaveLength(1));
    expect(sets()[0]!.input).toEqual({ target: "badge", enabled: false });
    expect(await screen.findByText("Выключено")).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Бейдж у ответа: кэш" })).toHaveProperty("disabled", true);
  });

  it("все поля строки сняты → «Нечего показывать»", async () => {
    await openSettings();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Строка треда: Σ токенов" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Строка треда: ток/с (эфф.)" }));
    expect(await screen.findByText("Нечего показывать — отметьте хотя бы одно поле")).toBeTruthy();
  });

  it("ошибка записи → текст ошибки, галочка откатывается", async () => {
    await openSettings({ failSet: true });
    const reasoning = await screen.findByRole("checkbox", { name: "Бейдж у ответа: reasoning" });
    fireEvent.click(reasoning);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "kv упал");
    await waitFor(() => expect(reasoning.getAttribute("data-state")).toBe("unchecked"));
  });
});