// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { RenderSlotOptions } from "@get-bb/plugin-sdk/testing/app";

// Модули, трогающие @get-bb/plugin-sdk/app, биндят рантайм при импорте —
// app.tsx импортируем только после установки рантайма loadPluginApp.
const app = await loadPluginApp(() => import("../app"));
const panel = app.navPanels[0]!;

const model = {
  id: "m-sol", name: "Sol", reasoning: true, contextWindow: 500000,
  compat: { supportsStore: false }, samplingParams: { reasoning_effort: "high" },
  apiKey: "leak", headers: { "X-M": "leak" },
  apiKeySet: true, headersSet: true, headerNames: ["X-M"],
};
const provider = {
  id: "router-test", name: "Router-Test", baseUrl: "http://localhost:4010/v1",
  api: "openai-completions", apiKeySet: true, headersSet: false, headerNames: [],
  models: [model], disabled: [],
};

function mount() {
  const slot = renderSlot({ component: panel.component }, { subPath: "" }, {
    rpc: {
      providers_list: () => ({ providers: [provider] }),
      models_discover: () => ({ models: [] }),
      models_sync_scan: () => ({ models: [] }),
      relay_accounts: () => ({ configured: false, items: [] }),
      rings_state: () => ({ selected: [], size: 40, perRow: 1 }),
      model_update: () => ({ id: "m-sol" }),
      provider_save: () => provider,
    } as never,
  } as RenderSlotOptions);
  return { calls: (method: string) => slot.inspection.rpcCalls.filter((c) => c.method === method) as Array<{ method: string; input: unknown }> };
}

async function openModelForm() {
  fireEvent.click(await screen.findByRole("tab", { name: "Подключение" }));
  fireEvent.click(await screen.findByRole("button", { name: /Router-Test/ }));
  const toggles = await screen.findAllByRole("button", { name: /m-sol/ });
  fireEvent.click(toggles.find((b) => b.hasAttribute("aria-expanded"))!);
  fireEvent.click(await screen.findByRole("button", { name: "API-настройки" }));
}

afterEach(cleanup);

describe("форма API-настроек модели", () => {
  it("JSON-поля видны, правка samplingParams уходит в model_update", async () => {
    const { calls } = mount();
    await openModelForm();
    const compat = await screen.findByLabelText("Совместимость (compat)") as HTMLTextAreaElement;
    expect(compat.value).toContain("supportsStore");
    fireEvent.change(screen.getByLabelText("Sampling-параметры"), { target: { value: '{"reasoning_effort": "medium"}' } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(calls("model_update")).toHaveLength(1));
    expect(calls("model_update")[0]!.input).toMatchObject({
      providerId: "router-test", modelId: "m-sol", patch: { samplingParams: { reasoning_effort: "medium" } },
    });
  });
  it("невалидный JSON не отправляется", async () => {
    const { calls } = mount();
    await openModelForm();
    fireEvent.change(await screen.findByLabelText("Sampling-параметры"), { target: { value: "{oops" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(calls("model_update")).toHaveLength(0);
  });
  it("очистка ключа модели шлёт apiKey: \"\"", async () => {
    const { calls } = mount();
    await openModelForm();
    fireEvent.click(await screen.findByRole("button", { name: "Очистить ключ модели" }));
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(calls("model_update")).toHaveLength(1));
    expect((calls("model_update")[0]!.input as { patch: Record<string, unknown> }).patch.apiKey).toBe("");
  });
  it("секретные значения не рендерятся: ключ и заголовки пусты", async () => {
    mount();
    await openModelForm();
    expect((await screen.findByLabelText("API-ключ модели") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Заголовки модели") as HTMLTextAreaElement).value).toBe("");
    expect(screen.getByText(/заданы: X-M/)).toBeTruthy();
  });
  it("значения apiKey/headers из записи не попадают в разметку (регресс toDraft-эха)", async () => {
    mount();
    await openModelForm();
    expect(document.body.textContent ?? "").not.toContain("leak");
    for (const node of Array.from(document.querySelectorAll("input, textarea"))) {
      expect((node as HTMLInputElement | HTMLTextAreaElement).value).not.toContain("leak");
    }
  });
  it("подсказки видны у простых advanced-контролов (api, baseUrl)", async () => {
    mount();
    await openModelForm();
    expect(screen.getByText("Пусто = тип API провайдера")).toBeTruthy();
    expect(screen.getByText("Пусто = адрес провайдера")).toBeTruthy();
  });
});
