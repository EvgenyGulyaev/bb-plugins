// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import type { BenchResult } from "../lib/contract.js";

const app = await loadPluginApp(() => import("../app"));
const settings = app.settingsSections.find((row) => row.id === "benchmark")!;
const slots: RenderedSlot[] = [];
const benchmark: BenchResult = {
  model: "model-a", genTokPerSec: 207.2, latencyMs: 1_040, at: Date.UTC(2026, 0, 2),
  samples: [
    { maxTokens: 150, outputTokens: 100, durationMs: 1_000 },
    { maxTokens: 1_500, outputTokens: 1_000, durationMs: 6_000 },
    { maxTokens: 150, outputTokens: 100, durationMs: 1_000 },
    { maxTokens: 1_500, outputTokens: 1_000, durationMs: 6_000 },
  ],
};

function mount(patch: {
  models?: string[];
  results?: BenchResult[];
  benchEnabled?: boolean;
  hasEndpoint?: boolean;
  benchModel?: (input: { model: string }) => Promise<BenchResult>;
} = {}) {
  const benchModel = patch.benchModel ?? (async () => benchmark);
  const slot = renderSlot({ component: settings.component }, {}, {
    pluginId: "token-meter",
    rpc: {
      bench_list: () => ({
        models: patch.models ?? ["model-a"],
        results: patch.results ?? [],
        benchEnabled: patch.benchEnabled ?? true,
        hasEndpoint: patch.hasEndpoint ?? true,
      }),
      bench_model: benchModel,
    } as never,
  });
  slots.push(slot);
  return { slot, benchModel };
}

afterEach(() => {
  for (const slot of slots.splice(0)) slot.unmount();
  cleanup();
});

describe("settingsSection benchmark", () => {
  it("регистрирует поддерживаемый settingsSection", () => {
    expect(settings.title).toBe("Замер скорости модели");
  });

  it("показывает модели из ходов, последний замер и вызывает bench_model по кнопке", async () => {
    const benchModel = vi.fn(async () => benchmark);
    const { slot } = mount({ models: ["model-a", "model-b"], results: [benchmark], benchModel });
    expect(await slot.findByText("model-a")).toBeTruthy();
    expect(slot.getByText("model-b")).toBeTruthy();
    expect(slot.getByText(/~207 ток\/с · задержка ~1.0 с · 2026-01-02/)).toBeTruthy();
    fireEvent.click(slot.getAllByRole("button", { name: "Замерить" })[0]!);
    await waitFor(() => expect(benchModel).toHaveBeenCalledWith({ model: "model-a" }));
    expect((await slot.findByRole("status")).textContent).toContain("model-a: ~207 ток/с, задержка ~1.0 с");
  });

  it("показывает ошибку замера и снова включает кнопку", async () => {
    const benchModel = vi.fn(async () => { throw new Error("замер неустойчив"); });
    const { slot } = mount({ benchModel });
    const button = await slot.findByRole("button", { name: "Замерить" });
    fireEvent.click(button);
    expect((await slot.findByRole("alert")).textContent).toContain("замер неустойчив");
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  });

  it.each([
    [{ benchEnabled: false, hasEndpoint: true }, /Включите benchEnabled/],
    [{ benchEnabled: true, hasEndpoint: false }, /Укажите benchEndpoint/],
  ])("без разрешённой конфигурации показывает подсказку и не вызывает сеть", async (config, hint) => {
    const benchModel = vi.fn(async () => benchmark);
    const { slot } = mount({ ...config, benchModel });
    expect(await slot.findByText(hint)).toBeTruthy();
    const button = slot.getByRole("button", { name: "Замерить" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(benchModel).not.toHaveBeenCalled();
  });
});
