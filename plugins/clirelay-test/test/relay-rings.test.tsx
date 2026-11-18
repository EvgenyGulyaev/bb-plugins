// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RelayRing, RelayRings } from "../components/relay-rings";
import type { RingsState } from "../lib/rings";
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

const item = (partial: Partial<Parameters<typeof RelayRing>[0]["item"]> = {}) => ({
  key: KEY("kimi:1"),
  origin: "http://relay:4010",
  authIndex: "kimi:1",
  label: "k@example.com",
  provider: "kimi",
  logo: "kimi",
  percent: 63,
  tone: "normal" as const,
  quotas: kimi.quotas,
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
    const { container } = render(<RelayRing item={item()} />);
    const button = screen.getByRole("button", { name: "k@example.com: осталось 63%" });
    expect(button.getAttribute("data-tone")).toBe("normal");
    expect(button.getAttribute("data-account-key")).toBe(KEY("kimi:1"));
    expect(button.querySelector(".relay-ring-percent")?.textContent).toBe("63%");
    expect(container.querySelector("circle[stroke-dasharray='63 100']")).not.toBeNull();
    expect(button.querySelectorAll("svg")).toHaveLength(2);
    expect(button.querySelector(".relay-ring-logo")?.innerHTML).toContain("<path");
  });

  it("shows a dash and the unknown tone without a percent", () => {
    render(<RelayRing item={item({ key: KEY("claude:1"), authIndex: "claude:1", label: "claude:1", provider: "claude", logo: "claude", percent: null, tone: "unknown", quotas: claude.quotas })} />);
    const button = screen.getByRole("button", { name: "claude:1: квота недоступна" });
    expect(button.getAttribute("data-tone")).toBe("unknown");
    expect(button.querySelector(".relay-ring-percent")?.textContent).toBe("—");
    expect(button.querySelectorAll(".relay-ring-fill")).toHaveLength(0);
  });

  it("maps low remainders to the warning and critical tones", () => {
    const { container, rerender } = render(<RelayRing item={item({ percent: 18, tone: "warning" })} />);
    expect(container.querySelector(".relay-ring-button")?.getAttribute("data-tone")).toBe("warning");
    rerender(<RelayRing item={item({ percent: 3, tone: "critical" })} />);
    expect(container.querySelector(".relay-ring-button")?.getAttribute("data-tone")).toBe("critical");
  });

  it("hides the printed percent below a 32px ring while keeping the full label", () => {
    const { rerender } = render(<RelayRing item={item()} size={24} />);
    expect(screen.queryByText("63%")).toBeNull();
    expect(screen.getByRole("button", { name: "k@example.com: осталось 63%" })).toBeTruthy();

    rerender(<RelayRing item={item()} size={32} />);
    expect(screen.getByText("63%")).toBeTruthy();
  });

  it("prints at most four characters under the ring", () => {
    const { rerender } = render(<RelayRing item={item({ percent: 41 })} size={40} />);
    expect(document.querySelector(".relay-ring-percent")?.textContent).toBe("41%");
    rerender(<RelayRing item={item({ percent: 100 })} size={40} />);
    expect(document.querySelector(".relay-ring-percent")?.textContent).toBe("100%");
    rerender(<RelayRing item={item({ percent: null, tone: "unknown", quotas: [] })} size={40} />);
    expect(document.querySelector(".relay-ring-percent")?.textContent).toBe("—");
  });

  it("falls back to the account initial when no logo is vendored", () => {
    const { container } = render(<RelayRing item={item({ key: KEY("gemini:1"), authIndex: "gemini:1", label: "gemini-work", provider: "gemini", logo: null, percent: null, tone: "unknown", quotas: [] })} />);
    expect(container.querySelector(".relay-ring-initial")?.textContent).toBe("G");
    expect(container.querySelector(".relay-ring-logo")).toBeNull();
  });

  it("lists every quota with localized labels and a reset countdown in the popover", async () => {
    render(<RelayRing item={item()} />);
    fireEvent.click(screen.getByRole("button", { name: /осталось 63%/ }));
    const dialog = await screen.findByLabelText("Квоты k@example.com");
    expect(within(dialog).getByText("Лимит 5 ч")).toBeTruthy();
    expect(within(dialog).getByText("Claude · 7 дн")).toBeTruthy();
    expect(dialog.querySelectorAll("meter")).toHaveLength(2);
    expect(within(dialog).getByText(/Сброс через/)).toBeTruthy();
  });

  it("explains an account without quotas in the popover", async () => {
    render(<RelayRing item={item({ key: KEY("gemini:1"), authIndex: "gemini:1", label: "gemini-work", provider: "gemini", logo: null, percent: null, tone: "unknown", quotas: [] })} />);
    fireEvent.click(screen.getByRole("button", { name: /квота недоступна/ }));
    const dialog = await screen.findByLabelText("Квоты gemini-work");
    expect(within(dialog).getByText("relay не сообщил квоту для этого аккаунта.")).toBeTruthy();
  });
});

describe("RelayRings", () => {
  const state = (selected: string[], size = 40, perRow = 1): RingsState => ({ selected, size, perRow });

  it("renders the selected accounts rings in selection order and carries the size", async () => {
    const stub = rpc([kimi, claude, gemini]);
    render(<RelayRings rpc={stub} state={state([KEY("claude:1"), KEY("kimi:1")], 48)} target={document.body} />);
    await waitFor(() => expect(document.querySelectorAll(".relay-ring-button")).toHaveLength(2));
    expect(Array.from(document.querySelectorAll(".relay-ring-button")).map((ring) => ring.getAttribute("data-account-key"))).toEqual([
      KEY("claude:1"),
      KEY("kimi:1"),
    ]);
    expect(document.querySelector<HTMLElement>(".relay-rings-list")?.style.getPropertyValue("--relay-ring-size")).toBe("48px");
  });

  it("lays the rings out in the chosen number of columns", async () => {
    const stub = rpc([kimi, claude, gemini]);
    const { rerender } = render(
      <RelayRings rpc={stub} state={state([KEY("kimi:1"), KEY("claude:1"), KEY("gemini:1")])} target={document.body} />,
    );
    await waitFor(() => expect(document.querySelectorAll(".relay-ring-button")).toHaveLength(3));
    const list = () => document.querySelector<HTMLElement>(".relay-rings-list")!;
    expect(list().style.getPropertyValue("--relay-ring-per-row")).toBe("1");
    expect(list().style.getPropertyValue("--relay-ring-size")).toBe("40px");

    rerender(<RelayRings rpc={stub} state={state([KEY("kimi:1"), KEY("claude:1"), KEY("gemini:1")], 40, 3)} target={document.body} />);
    await waitFor(() => expect(list().style.getPropertyValue("--relay-ring-per-row")).toBe("3"));
  });

  it("passes the size down so a small ring drops its printed percent", async () => {
    const stub = rpc([kimi]);
    render(<RelayRings rpc={stub} state={state([KEY("kimi:1")], 24)} target={document.body} />);
    await waitFor(() => expect(document.querySelectorAll(".relay-ring-button")).toHaveLength(1));
    expect(document.querySelector(".relay-ring-percent")).toBeNull();
    expect(screen.getByRole("button", { name: "k@example.com: осталось 63%" })).toBeTruthy();
  });

  it("ties each column to a fraction of the anchor instead of its own max-content", async () => {
    const stub = rpc([kimi, claude]);
    const { container } = render(
      <RelayRings rpc={stub} state={state([KEY("kimi:1"), KEY("claude:1")], 40, 2)} target={document.body} />,
    );
    await waitFor(() => expect(document.querySelectorAll(".relay-ring-button")).toHaveLength(2));
    const list = document.querySelector<HTMLElement>(".relay-rings-list")!;
    expect(list.style.gridTemplateColumns).toBe("repeat(2, minmax(0, 1fr))");
    expect(list.style.width).toBe("100%");
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
    // (40 - 4) / 2 = 18
    expect(list.style.getPropertyValue("--relay-ring-size")).toBe("18px");
    expect(list.style.gridTemplateColumns).toBe("repeat(2, minmax(0, 1fr))");
  });

  it("hides the printed percent when the measured rail makes the ring small", async () => {
    const anchor = document.createElement("div");
    anchor.getBoundingClientRect = () => ({ width: 40, height: 200, top: 0, left: 0, right: 40, bottom: 200, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    document.body.append(anchor);
    const stub = rpc([kimi]);
    render(<RelayRings rpc={stub} state={state([KEY("kimi:1")], 64, 1)} target={anchor} />);
    await waitFor(() => expect(anchor.querySelectorAll(".relay-ring-button")).toHaveLength(1));
    // one column in a 40px rail keeps 40px, so the percent stays
    expect(anchor.querySelector<HTMLElement>(".relay-rings-list")!.style.getPropertyValue("--relay-ring-size")).toBe("40px");
    expect(anchor.querySelector(".relay-ring-percent")?.textContent).toBe("63%");

    const narrow = document.createElement("div");
    narrow.getBoundingClientRect = () => ({ width: 28, height: 200, top: 0, left: 0, right: 28, bottom: 200, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    document.body.append(narrow);
    cleanup();
    render(<RelayRings rpc={stub} state={state([KEY("kimi:1")], 64, 1)} target={narrow} />);
    await waitFor(() => expect(narrow.querySelectorAll(".relay-ring-button")).toHaveLength(1));
    expect(narrow.querySelector<HTMLElement>(".relay-rings-list")!.style.getPropertyValue("--relay-ring-size")).toBe("28px");
    expect(narrow.querySelector(".relay-ring-percent")).toBeNull();
    expect(screen.getByRole("button", { name: "k@example.com: осталось 63%" })).toBeTruthy();
  });

  it("falls back to the setting while the anchor is not measured", async () => {
    const stub = rpc([kimi]);
    render(<RelayRings rpc={stub} state={state([KEY("kimi:1")], 48, 3)} target={document.body} />);
    await waitFor(() => expect(document.querySelectorAll(".relay-ring-button")).toHaveLength(1));
    expect(document.querySelector<HTMLElement>(".relay-rings-list")!.style.getPropertyValue("--relay-ring-size")).toBe("48px");
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

  it("draws nothing while no account is selected", async () => {
    const stub = rpc([kimi]);
    render(<RelayRings rpc={stub} state={state([])} target={document.body} />);
    await waitFor(() => expect(stub.call).toHaveBeenCalled());
    expect(document.querySelector(".relay-rings-list")).toBeNull();
  });

  it("drops a stale selection instead of drawing a placeholder", async () => {
    const stub = rpc([kimi]);
    render(<RelayRings rpc={stub} state={state([KEY("gone:1"), KEY("kimi:1")])} target={document.body} />);
    await waitFor(() => expect(document.querySelectorAll(".relay-ring-button")).toHaveLength(1));
    expect(document.querySelector(".relay-ring-button")?.getAttribute("data-account-key")).toBe(KEY("kimi:1"));
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
