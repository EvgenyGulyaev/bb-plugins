// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RelayRing, RelayRings } from "../components/relay-rings";
import type { RingAccountEntry, RingItem, RingsState } from "../lib/rings";
import type { RelayAccount } from "../lib/relay-accounts";

const kimi: RelayAccount = {
  auth_index: "kimi:1",
  provider: "kimi",
  email: "k@example.com",
  disabled: false,
  quotas: [
    { quota_key: "m_quota.code_5h", quota_label: "5-hour limit", percent: 63, reset_at: "2030-01-01T00:00:00.000Z" },
    { quota_key: "claude_seven_day", percent: 81 },
  ],
};
const claude: RelayAccount = {
  auth_index: "claude:1",
  provider: "claude",
  disabled: false,
  quotas: [{ quota_key: "5h", percent: null }],
};
const gemini: RelayAccount = {
  auth_index: "gemini:1",
  provider: "gemini",
  label: "gemini-work",
  disabled: false,
  quotas: [],
};

const KEY = (authIndex: string) => `http://relay:4010|${authIndex}`;

const entry = (partial: Partial<RingAccountEntry> & { key: string }): RingAccountEntry => ({
  label: partial.key,
  disabled: false,
  percent: null,
  quotas: [],
  ...partial,
});

const item = (partial: Partial<RingItem> = {}): RingItem => ({
  key: "kimi",
  type: "kimi",
  label: "Kimi",
  logo: "kimi",
  percent: 63,
  tone: "normal",
  activeCount: 1,
  accounts: [entry({ key: KEY("kimi:1"), label: "k@example.com", percent: 63, quotas: kimi.quotas })],
  ...partial,
});
/** Заглушка RPC панели: providers_list + relay_accounts (+ rings_state). */
function rpc(accounts: RelayAccount[], options: { failAccounts?: boolean } = {}) {
  return {
    call: vi.fn(async (method: string) => {
      if (method === "providers_list") {
        return { providers: [{ id: "p", baseUrl: "http://relay:4010/v1", api: "openai-completions", apiKeySet: true, models: [], disabled: [] }] };
      }
      if (method === "relay_accounts") {
        if (options.failAccounts) throw new Error("management-доступ отклонён");
        return { configured: true, items: accounts };
      }
      return {};
    }),
  };
}

const accountsCalls = (stub: ReturnType<typeof rpc>) =>
  stub.call.mock.calls.filter(([method]) => method === "relay_accounts");

afterEach(cleanup);

describe("RelayRing", () => {
  it("draws the ring, the logo and the percent", () => {
    const { container } = render(<RelayRing item={item()} sizePx={40} />);
    const button = screen.getByRole<HTMLButtonElement>("button", { name: "Kimi: осталось 63%" });
    expect(button.style.width).toBe("40px");
    expect(button.style.height).toBe("");
    expect(button.getAttribute("data-tone")).toBe("normal");
    expect(button.getAttribute("data-ring-key")).toBe("kimi");
    expect(button.querySelector(".relay-ring-percent")?.textContent).toBe("63%");
    expect(container.querySelector("circle[stroke-dasharray='63 100']")).not.toBeNull();
    expect(button.querySelectorAll("svg")).toHaveLength(2);
    expect(button.querySelector(".relay-ring-logo")?.innerHTML).toContain("<path");
  });

  it("names a multi-account ring as the biggest active one", () => {
    render(<RelayRing sizePx={40} item={item({
      activeCount: 2,
      accounts: [
        entry({ key: KEY("kimi:1"), label: "k@example.com", percent: 63, quotas: kimi.quotas }),
        entry({ key: KEY("kimi:2"), label: "kimi-2", percent: 31 }),
      ],
    })} />);
    expect(screen.getByRole("button", { name: "Kimi: осталось 63% (больший активный из 2)" })).toBeTruthy();
  });

  it("shows a dash and the unknown tone without a percent", () => {
    render(<RelayRing sizePx={40} item={item({ key: "claude", type: "claude", label: "Claude", logo: "claude", percent: null, tone: "unknown", accounts: [entry({ key: KEY("claude:1") })] })} />);
    const button = screen.getByRole("button", { name: "Claude: квота недоступна" });
    expect(button.getAttribute("data-tone")).toBe("unknown");
    expect(button.querySelector(".relay-ring-percent")?.textContent).toBe("—");
    expect(button.querySelectorAll(".relay-ring-fill")).toHaveLength(0);
  });

  it("maps low remainders to the warning and critical tones", () => {
    const { container, rerender } = render(<RelayRing sizePx={40} item={item({ percent: 18, tone: "warning" })} />);
    expect(container.querySelector(".relay-ring-button")?.getAttribute("data-tone")).toBe("warning");
    rerender(<RelayRing sizePx={40} item={item({ percent: 3, tone: "critical" })} />);
    expect(container.querySelector(".relay-ring-button")?.getAttribute("data-tone")).toBe("critical");
  });

  it("always prints the percent instead of hiding it on a small ring", () => {
    render(<RelayRing sizePx={40} item={item()} />);
    expect(screen.getByText("63%")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Kimi: осталось 63%" })).toBeTruthy();
  });

  it("scales the percent with the ring through a clamped font size", async () => {
    const { readFile } = await import("node:fs/promises");
    const css = await readFile(`${process.cwd()}/app.css`, "utf8");
    const rule = css.slice(css.indexOf(".relay-ring-percent {"));
    const body = rule.slice(0, rule.indexOf("}"));
    expect(body).toMatch(/font-size:\s*clamp\(\s*7px\s*,\s*calc\(var\(--relay-ring-size\) \* 0\.26\)\s*,\s*12px\s*\)/);
    expect(body).toContain("line-height: 1");
    expect(body).toContain("width: 100%");
    expect(body).toContain("max-width: 100%");
    expect(body).toContain("text-align: center");
    expect(body).toContain("white-space: nowrap");
  });

  it("prints at most four characters under the ring", () => {
    const { rerender } = render(<RelayRing sizePx={40} item={item({ percent: 41 })} />);
    expect(document.querySelector(".relay-ring-percent")?.textContent).toBe("41%");
    rerender(<RelayRing sizePx={40} item={item({ percent: 100 })} />);
    expect(document.querySelector(".relay-ring-percent")?.textContent).toBe("100%");
    rerender(<RelayRing sizePx={40} item={item({ percent: null, tone: "unknown", accounts: [] })} />);
    expect(document.querySelector(".relay-ring-percent")?.textContent).toBe("—");
  });

  it("falls back to the type initial when no logo is vendored", () => {
    const { container } = render(<RelayRing sizePx={40} item={item({ key: "gemini", type: "gemini", label: "Gemini", logo: null, percent: null, tone: "unknown", accounts: [entry({ key: KEY("gemini:1"), label: "gemini-work" })] })} />);
    expect(container.querySelector(".relay-ring-initial")?.textContent).toBe("G");
    expect(container.querySelector(".relay-ring-logo")).toBeNull();
  });

  it("lists every quota of a single account with localized labels and a reset countdown", async () => {
    render(<RelayRing sizePx={40} item={item()} />);
    fireEvent.click(screen.getByRole("button", { name: /осталось 63%/ }));
    const dialog = await screen.findByLabelText("Квоты Kimi");
    expect(within(dialog).getByText("k@example.com")).toBeTruthy();
    expect(within(dialog).getByText("Лимит 5 ч")).toBeTruthy();
    expect(within(dialog).getByText("Claude · 7 дн")).toBeTruthy();
    expect(dialog.querySelectorAll("meter")).toHaveLength(2);
    expect(within(dialog).getByText(/Сброс через/)).toBeTruthy();
  });

  it("lists every account of the type with its quotas and a disabled mark", async () => {
    render(<RelayRing sizePx={40} item={item({
      activeCount: 2,
      accounts: [
        entry({ key: KEY("kimi:1"), label: "k@example.com", percent: 63, quotas: kimi.quotas }),
        entry({ key: KEY("kimi:2"), label: "kimi-2", percent: 31, quotas: [{ quota_key: "m_quota.code_weekly", percent: 31 }] }),
        entry({ key: KEY("kimi:3"), label: "kimi-off", disabled: true, percent: 12, quotas: [{ quota_key: "5h", percent: 12 }] }),
      ],
    })} />);
    fireEvent.click(screen.getByRole("button", { name: /больший активный из 2/ }));
    const dialog = await screen.findByLabelText("Квоты Kimi");
    const accounts = Array.from(dialog.querySelectorAll(".relay-rings-account"));
    expect(accounts).toHaveLength(3);
    expect(accounts.map((node) => node.querySelector(".relay-rings-account-label")?.textContent)).toEqual([
      "k@example.com63%",
      "kimi-231%",
      "kimi-offвыключен12%",
    ]);
    expect(accounts[2]?.getAttribute("data-disabled")).toBe("");
  });

  it("lets the logo inherit the ring tone instead of forcing its own color", async () => {
    render(<RelayRing sizePx={40} item={item({ percent: 3, tone: "critical" })} />);
    const button = document.querySelector<HTMLElement>(".relay-ring-button")!;
    expect(button.getAttribute("data-tone")).toBe("critical");
    // currentColor в вендоренном SVG должен идти от тона кнопки: собственный
    // `color` у логотипа перебил бы warning/critical.
    const logo = document.querySelector<HTMLElement>(".relay-ring-logo")!;
    expect(logo.style.color).toBe("");
    const { readFile } = await import("node:fs/promises");
    const css = await readFile(`${process.cwd()}/app.css`, "utf8");
    const rule = css.slice(css.indexOf(".relay-ring-logo {"));
    const body = rule.slice(0, rule.indexOf("}"));
    // либо без color вовсе, либо inherit — но не собственная палитра
    expect(body).not.toContain("--sidebar-foreground");
    const color = /(^|[;{\s])color\s*:\s*([^;]+);/.exec(body)?.[2]?.trim();
    expect(color === undefined || color === "inherit").toBe(true);
  });

  it("explains an account without quotas in the popover", async () => {
    render(<RelayRing sizePx={40} item={item({ key: "gemini", type: "gemini", label: "Gemini", logo: null, percent: null, tone: "unknown", accounts: [entry({ key: KEY("gemini:1"), label: "gemini-work" })] })} />);
    fireEvent.click(screen.getByRole("button", { name: /квота недоступна/ }));
    const dialog = await screen.findByLabelText("Квоты Gemini");
    expect(within(dialog).getByText("gemini-work")).toBeTruthy();
    expect(within(dialog).getByText("relay не сообщил квоту для этого аккаунта.")).toBeTruthy();
  });
});

describe("RelayRings", () => {
  const state = (selected: string[], size = 40, perRow = 1): RingsState => ({ selected, size, perRow });

  it("renders one ring per provider type and carries the size", async () => {
    const stub = rpc([kimi, claude, gemini]);
    render(<RelayRings rpc={stub} state={state([KEY("claude:1"), KEY("kimi:1")], 48)} target={document.body} />);
    await waitFor(() => expect(document.querySelectorAll(".relay-ring-button")).toHaveLength(2));
    expect(Array.from(document.querySelectorAll(".relay-ring-button")).map((ring) => ring.getAttribute("data-ring-key"))).toEqual([
      "claude",
      "kimi",
    ]);
    expect(document.querySelector<HTMLElement>(".relay-rings-list")?.style.getPropertyValue("--relay-ring-size")).toBe("48px");
    expect(Array.from(document.querySelectorAll<HTMLElement>(".relay-ring-button")).every((button) => button.style.width === "48px")).toBe(true);
  });

  it("lays the rings out in the chosen number of columns", async () => {
    const stub = rpc([kimi, claude, gemini]);
    const { rerender } = render(
      <RelayRings rpc={stub} state={state([KEY("kimi:1"), KEY("claude:1"), KEY("gemini:1")])} target={document.body} />,
    );
    await waitFor(() => expect(document.querySelectorAll(".relay-ring-button")).toHaveLength(3));
    const list = () => document.querySelector<HTMLElement>(".relay-rings-list")!;
    const buttons = () => Array.from(document.querySelectorAll<HTMLElement>(".relay-ring-button"));
    expect(buttons().every((button) => button.style.width === "40px")).toBe(true);
    expect(buttons().every((button) => !/var\(|basis/.test(button.getAttribute("style") ?? ""))).toBe(true);
    expect(list().style.getPropertyValue("--relay-ring-size")).toBe("40px");

    rerender(<RelayRings rpc={stub} state={state([KEY("kimi:1"), KEY("claude:1"), KEY("gemini:1")], 40, 3)} target={document.body} />);
    await waitFor(() => expect(buttons().every((button) => button.style.width === "40px")).toBe(true));
  });

  it("pins the flex row that centres an incomplete last row", async () => {
    const { readFile } = await import("node:fs/promises");
    const css = await readFile(`${process.cwd()}/app.css`, "utf8");
    const listRule = css.slice(css.indexOf(".relay-rings-list {"));
    const list = listRule.slice(0, listRule.indexOf("}"));
    expect(list).toMatch(/display:\s*flex;/);
    expect(list).toMatch(/flex-wrap:\s*wrap;/);
    expect(list).toMatch(/justify-content:\s*center;/);
    expect(list).toMatch(/gap:\s*4px;/);
    expect(list).toMatch(/width:\s*100%;/);
    expect(list).toMatch(/padding:\s*3px;/);

    const buttonRule = css.slice(css.indexOf(".relay-ring-button {"));
    const button = buttonRule.slice(0, buttonRule.indexOf("}"));
    // Ширина колонки приходит инлайном в px; calc/var для flex-basis не нужны.
    expect(button).toMatch(/flex:\s*0\s+0\s+auto;/);
    expect(button).toMatch(/width:\s*var\(--relay-ring-size\);/);
    expect(button).toMatch(/max-width:\s*none;/);
    expect(button).not.toMatch(/basis/);
  });

  it("centres a lone ring of an incomplete last row (3 rings, 2 columns)", async () => {
    const stub = rpc([kimi, claude, gemini]);
    render(
      <RelayRings rpc={stub} state={state([KEY("kimi:1"), KEY("claude:1"), KEY("gemini:1")], 40, 2)} target={document.body} />,
    );
    await waitFor(() => expect(document.querySelectorAll(".relay-ring-button")).toHaveLength(3));
    // Строка неполная: центрирование даёт flex-контейнер с justify-content:center,
    // а третье кольцо занимает свою колонку, а не растягивается на всю ширину.
    const buttons = Array.from(document.querySelectorAll<HTMLElement>(".relay-ring-button"));
    expect(buttons).toHaveLength(3);
    expect(buttons.every((button) => button.style.width === "40px")).toBe(true);
    expect(buttons.every((button) => button.style.flex === "")).toBe(true);
  });

  it("wraps two rings per row when the setting says two columns", async () => {
    const stub = rpc([kimi, claude]);
    render(<RelayRings rpc={stub} state={state([KEY("kimi:1"), KEY("claude:1")], 40, 2)} target={document.body} />);
    await waitFor(() => expect(document.querySelectorAll(".relay-ring-button")).toHaveLength(2));
    const list = document.querySelector<HTMLElement>(".relay-rings-list")!;
    const buttons = Array.from(document.querySelectorAll<HTMLElement>(".relay-ring-button"));
    // Фиксированная px-ширина кнопок плюс gap даёт две колонки без calc().
    expect(buttons.every((button) => button.style.width === "40px")).toBe(true);
    expect(buttons.every((button) => !/var\(|basis/.test(button.getAttribute("style") ?? ""))).toBe(true);
    expect(list.style.getPropertyValue("--relay-ring-size")).toBe("40px");
    expect(buttons.every((button) => button.style.flex === "")).toBe(true);
  });

  it("keeps the printed percent on a small ring and only shrinks it", async () => {
    const stub = rpc([kimi]);
    render(<RelayRings rpc={stub} state={state([KEY("kimi:1")], 24)} target={document.body} />);
    await waitFor(() => expect(document.querySelectorAll(".relay-ring-button")).toHaveLength(1));
    expect(document.querySelector(".relay-ring-percent")?.textContent).toBe("63%");
    expect(screen.getByRole("button", { name: "Kimi: осталось 63%" })).toBeTruthy();
  });

  it.each([
    [1, 32],
    [2, 15],
    [3, 12],
  ])("gives each ring an inline pixel width for %i columns", async (perRow, expected) => {
    const anchor = document.createElement("div");
    anchor.getBoundingClientRect = () => ({ width: 40, height: 200, top: 0, left: 0, right: 40, bottom: 200, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    document.body.append(anchor);
    const stub = rpc([kimi, claude]);
    const { container } = render(
      <RelayRings rpc={stub} state={state([KEY("kimi:1"), KEY("claude:1")], 32, perRow)} target={anchor} />,
    );
    await waitFor(() => expect(anchor.querySelectorAll(".relay-ring-button")).toHaveLength(2));
    const list = anchor.querySelector<HTMLElement>(".relay-rings-list")!;
    const buttons = Array.from(anchor.querySelectorAll<HTMLElement>(".relay-ring-button"));
    expect(buttons.every((button) => button.style.width === `${expected}px`)).toBe(true);
    expect(buttons.every((button) => !/var\(|basis/.test(button.getAttribute("style") ?? ""))).toBe(true);
    expect(buttons.every((button) => button.style.height === "")).toBe(true);
    expect(list.style.width).toBe("100%");
    expect(list.style.gridTemplateColumns).toBe("");
    expect(container).toBeTruthy();
  });

  it("shrinks the rings into a narrow rail so they are not clipped", async () => {
    const anchor = document.createElement("div");
    anchor.getBoundingClientRect = () => ({ width: 40, height: 200, top: 0, left: 0, right: 40, bottom: 200, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    document.body.append(anchor);
    const stub = rpc([kimi, claude, gemini]);
    render(
      <RelayRings
        rpc={stub}
        state={state([KEY("kimi:1"), KEY("claude:1"), KEY("gemini:1")], 40, 2)}
        target={anchor}
      />,
    );
    await waitFor(() => expect(anchor.querySelectorAll(".relay-ring-button")).toHaveLength(3));
    const list = anchor.querySelector<HTMLElement>(".relay-rings-list")!;
    // content: 40 - 2 * 3 = 34; (34 - 4) / 2 = 15
    expect(list.style.getPropertyValue("--relay-ring-size")).toBe("15px");
    expect(Array.from(anchor.querySelectorAll<HTMLElement>(".relay-ring-button")).every((button) => button.style.width === "15px")).toBe(true);
  });

  it("keeps the printed percent at a 15px effective ring and shrinks it with the size", async () => {
    const anchor = document.createElement("div");
    anchor.getBoundingClientRect = () => ({ width: 40, height: 200, top: 0, left: 0, right: 40, bottom: 200, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    document.body.append(anchor);
    const stub = rpc([kimi]);
    render(<RelayRings rpc={stub} state={state([KEY("kimi:1")], 32, 1)} target={anchor} />);
    await waitFor(() => expect(anchor.querySelectorAll(".relay-ring-button")).toHaveLength(1));
    // одна колонка: min(32, 40 - 2 * 3) = 32px, подпись остаётся
    expect(anchor.querySelector<HTMLElement>(".relay-rings-list")!.style.getPropertyValue("--relay-ring-size")).toBe("32px");
    expect(anchor.querySelector<HTMLElement>(".relay-ring-button")!.style.width).toBe("32px");
    expect(anchor.querySelector(".relay-ring-percent")?.textContent).toBe("63%");

    // две колонки в 40px рейле: content 34px, effective 15px
    // подпись остаётся и ужимается
    const narrow = document.createElement("div");
    narrow.getBoundingClientRect = () => ({ width: 40, height: 200, top: 0, left: 0, right: 40, bottom: 200, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    document.body.append(narrow);
    cleanup();
    const pair = rpc([kimi]);
    render(<RelayRings rpc={pair} state={state([KEY("kimi:1")], 64, 2)} target={narrow} />);
    await waitFor(() => expect(narrow.querySelectorAll(".relay-ring-button")).toHaveLength(1));
    expect(narrow.querySelector<HTMLElement>(".relay-rings-list")!.style.getPropertyValue("--relay-ring-size")).toBe("15px");
    expect(narrow.querySelector<HTMLElement>(".relay-ring-button")!.style.width).toBe("15px");
    expect(narrow.querySelector(".relay-ring-percent")?.textContent).toBe("63%");
    expect(screen.getByRole("button", { name: "Kimi: осталось 63%" })).toBeTruthy();
  });

  it("keeps the printed percent even at the 12px floor of a four-column rail", async () => {
    const anchor = document.createElement("div");
    anchor.getBoundingClientRect = () => ({ width: 40, height: 200, top: 0, left: 0, right: 40, bottom: 200, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    document.body.append(anchor);
    const stub = rpc([kimi]);
    render(<RelayRings rpc={stub} state={state([KEY("kimi:1")], 64, 4)} target={anchor} />);
    await waitFor(() => expect(anchor.querySelectorAll(".relay-ring-button")).toHaveLength(1));
    expect(anchor.querySelector<HTMLElement>(".relay-rings-list")!.style.getPropertyValue("--relay-ring-size")).toBe("12px");
    expect(anchor.querySelector(".relay-ring-percent")?.textContent).toBe("63%");
    expect(screen.getByRole("button", { name: "Kimi: осталось 63%" })).toBeTruthy();
  });

  it("falls back to the setting while the anchor is not measured", async () => {
    const stub = rpc([kimi]);
    render(<RelayRings rpc={stub} state={state([KEY("kimi:1")], 48, 3)} target={document.body} />);
    await waitFor(() => expect(document.querySelectorAll(".relay-ring-button")).toHaveLength(1));
    expect(document.querySelector<HTMLElement>(".relay-rings-list")!.style.getPropertyValue("--relay-ring-size")).toBe("48px");
  });

  it("draws one ring for two accounts of the same type", async () => {
    const second: RelayAccount = {
      auth_index: "kimi:2",
      provider: "kimi",
      label: "kimi-2",
      disabled: false,
      quotas: [{ quota_key: "m_quota.code_weekly", percent: 12 }],
    };
    const off: RelayAccount = {
      auth_index: "kimi:3",
      provider: "kimi",
      label: "kimi-off",
      disabled: true,
      quotas: [{ quota_key: "m_quota.code_weekly", percent: 99 }],
    };
    const stub = rpc([kimi, second, off]);
    render(
      <RelayRings
        rpc={stub}
        state={state([KEY("kimi:1"), KEY("kimi:2"), KEY("kimi:3")])}
        target={document.body}
      />,
    );
    await waitFor(() => expect(document.querySelectorAll(".relay-ring-button")).toHaveLength(1));
    const button = document.querySelector(".relay-ring-button")!;
    // максимум среди активных: 63, выключенное ведро с 99 не учитывается
    expect(button.getAttribute("data-tone")).toBe("normal");
    expect(screen.getByRole("button", { name: "Kimi: осталось 63% (больший активный из 2)" })).toBeTruthy();
    fireEvent.click(button);
    const dialog = await screen.findByLabelText("Квоты Kimi");
    expect(Array.from(dialog.querySelectorAll(".relay-rings-account"))).toHaveLength(3);
  });

  it("draws the vendored gpt artwork for an OpenAI account", async () => {
    const gpt: RelayAccount = {
      auth_index: "gpt:1",
      provider: "openai",
      label: "gpt-work",
      disabled: false,
      quotas: [{ quota_key: "weekly", percent: 77 }],
    };
    const stub = rpc([gpt]);
    render(<RelayRings rpc={stub} state={state(["http://relay:4010|gpt:1"])} target={document.body} />);
    await waitFor(() => expect(document.querySelectorAll(".relay-ring-button")).toHaveLength(1));
    const button = document.querySelector(".relay-ring-button")!;
    expect(button.getAttribute("data-tone")).toBe("normal");
    expect(button.querySelector(".relay-ring-logo")?.innerHTML).toContain("<path");
    expect(button.querySelector(".relay-ring-initial")).toBeNull();
  });

  it("draws nothing and asks the server nothing while no account is selected", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const stub = rpc([kimi]);
      render(<RelayRings rpc={stub} state={state([])} target={document.body} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(document.querySelector(".relay-rings-list")).toBeNull();
      // ни первичной загрузки, ни тика интервала: RPC не трогаем вовсе
      expect(stub.call).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
      expect(stub.call).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops polling as soon as the last account is unticked", async () => {
    const stub = rpc([kimi]);
    const { rerender } = render(<RelayRings rpc={stub} state={state([KEY("kimi:1")])} target={document.body} />);
    await waitFor(() => expect(accountsCalls(stub)).toHaveLength(1));
    rerender(<RelayRings rpc={stub} state={state([])} target={document.body} />);
    await waitFor(() => expect(document.querySelectorAll(".relay-ring-button")).toHaveLength(0));
    const calls = stub.call.mock.calls.length;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    } finally {
      vi.useRealTimers();
    }
    expect(stub.call.mock.calls.length).toBe(calls);
  });

  it("drops a stale selection instead of drawing a placeholder", async () => {
    const stub = rpc([kimi]);
    render(<RelayRings rpc={stub} state={state([KEY("gone:1"), KEY("kimi:1")])} target={document.body} />);
    await waitFor(() => expect(document.querySelectorAll(".relay-ring-button")).toHaveLength(1));
    expect(document.querySelector(".relay-ring-button")?.getAttribute("data-ring-key")).toBe("kimi");
  });

  it("polls the accounts every minute", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const stub = rpc([kimi]);
      render(<RelayRings rpc={stub} state={state([KEY("kimi:1")])} target={document.body} />);
      await waitFor(() => expect(accountsCalls(stub)).toHaveLength(1));
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      await waitFor(() => expect(accountsCalls(stub)).toHaveLength(2));
    } finally {
      vi.useRealTimers();
    }
  });

  it("refetches when the reload signal changes", async () => {
    const stub = rpc([kimi]);
    const { rerender } = render(<RelayRings rpc={stub} state={state([KEY("kimi:1")])} target={document.body} reloadSignal={0} />);
    await waitFor(() => expect(accountsCalls(stub)).toHaveLength(1));
    rerender(<RelayRings rpc={stub} state={state([KEY("kimi:1")])} target={document.body} reloadSignal={1} />);
    await waitFor(() => expect(accountsCalls(stub)).toHaveLength(2));
  });

  it("renders into the given anchor, not the render container", async () => {
    const anchor = document.createElement("div");
    document.body.append(anchor);
    const { container } = render(<RelayRings rpc={rpc([kimi])} state={state([KEY("kimi:1")])} target={anchor} />);
    await waitFor(() => expect(anchor.querySelectorAll(".relay-ring-button")).toHaveLength(1));
    expect(container.querySelector(".relay-ring-button")).toBeNull();
  });

  it("keeps drawing the rings when the relaying accounts call fails", async () => {
    const stub = rpc([], { failAccounts: true });
    render(<RelayRings rpc={stub} state={state([KEY("kimi:1")])} target={document.body} />);
    await waitFor(() => expect(accountsCalls(stub)).toHaveLength(1));
    expect(document.querySelector(".relay-rings-list")).toBeNull();
  });
});
