// @vitest-environment jsdom
// Синхронизатор моделей: scan ничего не пишет, apply — только по подтверждению.
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { RenderedSlot, RenderSlotOptions } from "@get-bb/plugin-sdk/testing/app";

const toastCalls: string[] = [];
vi.mock("sonner", () => {
  const record = (kind: string) => (message: string) => { toastCalls.push(`${kind}:${message}`); };
  return { toast: Object.assign(record("info"), { success: record("success"), error: record("error"), warning: record("warning") }) };
});

const app = await loadPluginApp(() => import("../app"));
const panel = app.navPanels[0]!;

const donor = {
  id: "gpt-6.2-sol",
  name: "GPT-6.2 Sol",
  contextWindow: 100,
  maxTokens: 50,
  input: ["text"],
};

const provider = {
  id: "router-test",
  name: "Router-Test",
  baseUrl: "http://localhost:4010/v1",
  api: "openai-completions",
  apiKeySet: true,
  headersSet: false,
  headerNames: [],
  models: [donor],
  disabled: [],
};

type ScanModel = {
  id: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: string[];
  supportedReasoningLevels?: string[];
  donor?: Record<string, unknown>;
  donorCandidates?: Array<Record<string, unknown>>;
};

type Providers = typeof provider;

function mount(scan: ScanModel[], options: { applyError?: string; applyResult?: unknown; providers?: Providers[] } = {}) {
  let providers = options.providers ?? [provider];
  const slot: RenderedSlot = renderSlot({ component: panel.component }, { subPath: "" }, {
    rpc: {
      providers_list: () => ({ providers }),
      models_discover: () => ({ models: [] }),
      models_sync_scan: () => ({ models: scan }),
      relay_accounts: () => ({ configured: false, items: [] }),
      rings_state: () => ({ selected: [], size: 40, perRow: 1 }),
      model_connect: () => ({ connected: true }),
      model_sync_apply: () => {
        if (options.applyError) throw new Error(options.applyError);
        return options.applyResult ?? { status: "applied", modelAdded: true, settings: "skipped", sources: { contextWindow: "api", maxTokens: "api", input: "api" } };
      },
    } as never,
  } as RenderSlotOptions);
  return {
    slot,
    calls: (method: string) => slot.inspection.rpcCalls.filter((call) => call.method === method) as Array<{ method: string; input: unknown }>,
    setProviders: (next: Providers[]) => { providers = next; },
  };
}

async function openConnectTab() {
  fireEvent.click(await screen.findByRole("tab", { name: "Подключение" }));
  fireEvent.click(await screen.findByRole("button", { name: /Router-Test/ }));
}

beforeEach(() => { toastCalls.length = 0; });
afterEach(cleanup);

const upgrade: ScanModel = {
  id: "gpt-7.1-sol",
  contextWindow: 200000,
  maxTokens: 8192,
  input: ["text", "image"],
  supportedReasoningLevels: ["off", "high"],
  donor: { id: "gpt-6.2-sol", name: "GPT-6.2 Sol", enabled: true, contextWindow: 100, maxTokens: 50, input: ["text"] },
  donorCandidates: [],
};

describe("scan", () => {
  it("кнопка «Проверить обновления» вызывает models_sync_scan и ничего не пишет", async () => {
    const { calls } = mount([upgrade]);
    await openConnectTab();
    fireEvent.click(await screen.findByRole("button", { name: "Проверить обновления" }));
    await waitFor(() => expect(calls("models_sync_scan").length).toBeGreaterThan(0));
    expect(calls("model_sync_apply")).toHaveLength(0);
    expect(calls("model_connect")).toHaveLength(0);
  });

  it("однозначный donor: карточка «Обновление» и кнопка с именем донора", async () => {
    mount([upgrade]);
    await openConnectTab();
    expect(await screen.findByText("Обновление")).toBeTruthy();
    expect(screen.getByText(/источники лимитов/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Подключить с настройками GPT-6.2 Sol" })).toBeTruthy();
    // обычное подключение остаётся доступным
    expect(screen.getByRole("button", { name: "Подключить gpt-7.1-sol" })).toBeTruthy();
  });

  it("ambiguous: select без выбора и кнопка «С настройками…» заблокирована до выбора", async () => {
    mount([{
      id: "gpt-7.1-sol",
      donorCandidates: [
        { id: "gpt-6.2-sol", name: "GPT-6.2 Sol", enabled: true },
        { id: "gpt-v6.2.0-sol", enabled: false },
      ],
    }]);
    await openConnectTab();
    const select = await screen.findByLabelText("Скопировать настройки из…") as HTMLSelectElement;
    expect(select.value).toBe("");
    const button = screen.getByRole("button", { name: "С настройками…" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(select, { target: { value: "gpt-v6.2.0-sol" } });
    await waitFor(() => expect((screen.getByRole("button", { name: "С настройками…" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("подключённая модель исчезает из «Новых» после realtime-обновления", async () => {
    const { slot, calls, setProviders } = mount([{ id: "new-1", donorCandidates: [] }]);
    await openConnectTab();
    expect(await screen.findByRole("button", { name: "Подключить new-1" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Подключить new-1" }));
    await waitFor(() => expect(calls("model_connect")).toHaveLength(1));
    // Сервер пишет модель в models.json и публикует api-models-changed.
    setProviders([{ ...provider, models: [...provider.models, { ...donor, id: "new-1" }] }]);
    await slot.behavior.emitRealtime("api-models-changed", {});
    await waitFor(() => expect(screen.queryByRole("button", { name: "Подключить new-1" })).toBeNull());
  });

  it("обычная новая модель: только «Подключить»", async () => {
    mount([{ id: "gpt-7.1-eco", donorCandidates: [] }]);
    await openConnectTab();
    expect(await screen.findByRole("button", { name: "Подключить gpt-7.1-eco" })).toBeTruthy();
    expect(screen.queryByText("Обновление")).toBeNull();
    expect(screen.queryByLabelText("Скопировать настройки из…")).toBeNull();
  });
});

describe("диалог подтверждения", () => {
  it("открывается без записи; отмена не вызывает apply", async () => {
    const { calls } = mount([upgrade]);
    await openConnectTab();
    fireEvent.click(await screen.findByRole("button", { name: "Подключить с настройками GPT-6.2 Sol" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("gpt-7.1-sol")).toBeTruthy();
    const checkbox = within(dialog).getByRole("checkbox", { name: "Заменить в выборе pi" }) as HTMLElement;
    expect(checkbox.getAttribute("data-state")).toBe("unchecked");
    expect(within(dialog).getByText(/Старую модель не отключаем\. defaultModel\/defaultProvider не меняем/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Отмена" }));
    expect(calls("model_sync_apply")).toHaveLength(0);
  });

  it("показывает итоговые значения с источниками API/donor/default", async () => {
    mount([upgrade]);
    await openConnectTab();
    fireEvent.click(await screen.findByRole("button", { name: "Подключить с настройками GPT-6.2 Sol" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/200000 \(API\)/)).toBeTruthy();
    expect(within(dialog).getByText(/8192 \(API\)/)).toBeTruthy();
    expect(within(dialog).getByText(/text, image \(API\)/)).toBeTruthy();
    expect(within(dialog).getByText(/API\/baseUrl, reasoning, input, sampling, compat, cost\/promptCache, ключ и заголовки donor/)).toBeTruthy();
  });

  it("fallback: значения донора и pi default подписаны", async () => {
    mount([{ id: "gpt-7.1-sol", donor: { id: "gpt-6.2-sol", name: "GPT-6.2 Sol", enabled: true, contextWindow: 100, maxTokens: 50, input: ["text"] }, donorCandidates: [] }]);
    await openConnectTab();
    fireEvent.click(await screen.findByRole("button", { name: "Подключить с настройками GPT-6.2 Sol" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/100 \(donor fallback\)/)).toBeTruthy();
    expect(within(dialog).getByText(/50 \(donor fallback\)/)).toBeTruthy();
    expect(within(dialog).getByText(/text \(donor fallback\)/)).toBeTruthy();
  });

  it("confirm шлёт точный payload, галочка по умолчанию false, двойной клик = один RPC", async () => {
    const { calls } = mount([upgrade]);
    await openConnectTab();
    fireEvent.click(await screen.findByRole("button", { name: "Подключить с настройками GPT-6.2 Sol" }));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Подключить" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(calls("model_sync_apply")).toHaveLength(1));
    expect(calls("model_sync_apply")[0]!.input).toEqual({
      providerId: "router-test", modelId: "gpt-7.1-sol", donorId: "gpt-6.2-sol", replaceInPi: false,
    });
    await waitFor(() => expect(toastCalls).toContain("success:Подключена gpt-7.1-sol; открой /model в pi заново"));
  });

  it("галочка включает replaceInPi:true", async () => {
    const { calls } = mount([upgrade]);
    await openConnectTab();
    fireEvent.click(await screen.findByRole("button", { name: "Подключить с настройками GPT-6.2 Sol" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Заменить в выборе pi" }));
    await waitFor(() => expect((within(dialog).getByRole("checkbox", { name: "Заменить в выборе pi" }) as HTMLElement).getAttribute("data-state")).toBe("checked"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Подключить" }));
    await waitFor(() => expect(calls("model_sync_apply")).toHaveLength(1));
    expect((calls("model_sync_apply")[0]!.input as { replaceInPi: boolean }).replaceInPi).toBe(true);
  });

  it("partial → предупреждение и диалог остаётся для повтора с той же галочкой", async () => {
    const { calls } = mount([upgrade], {
      applyResult: { status: "partial", modelAdded: true, settings: "failed", sources: { contextWindow: "api", maxTokens: "api", input: "api" } },
    });
    await openConnectTab();
    fireEvent.click(await screen.findByRole("button", { name: "Подключить с настройками GPT-6.2 Sol" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Заменить в выборе pi" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Подключить" }));
    expect(await screen.findByText("Модель подключена, выбор pi не изменён. Повторите с той же галочкой")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Подключить" }));
    await waitFor(() => expect(calls("model_sync_apply")).toHaveLength(2));
    expect((calls("model_sync_apply")[1]!.input as { replaceInPi: boolean }).replaceInPi).toBe(true);
  });

  it("ошибка RPC не выдаётся за успех: диалог остаётся, показывается ошибка", async () => {
    mount([upgrade], { applyError: "settings.json повреждён" });
    await openConnectTab();
    fireEvent.click(await screen.findByRole("button", { name: "Подключить с настройками GPT-6.2 Sol" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Подключить" }));
    await waitFor(() => expect(screen.getAllByText(/settings\.json повреждён/).length).toBeGreaterThan(0));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(toastCalls.some((call) => call.startsWith("success:"))).toBe(false);
  });

  it("ambiguous: выбранный кандидат уходит как donorId", async () => {
    const { calls } = mount([{
      id: "gpt-7.1-sol",
      donorCandidates: [{ id: "gpt-6.2-sol", name: "GPT-6.2 Sol", enabled: true }, { id: "gpt-v6.2.0-sol", enabled: false }],
    }]);
    await openConnectTab();
    fireEvent.change(await screen.findByLabelText("Скопировать настройки из…"), { target: { value: "gpt-v6.2.0-sol" } });
    fireEvent.click(await screen.findByRole("button", { name: "С настройками…" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Подключить" }));
    await waitFor(() => expect(calls("model_sync_apply")).toHaveLength(1));
    expect(calls("model_sync_apply")[0]!.input).toEqual({
      providerId: "router-test", modelId: "gpt-7.1-sol", donorId: "gpt-v6.2.0-sol", replaceInPi: false,
    });
  });
});
