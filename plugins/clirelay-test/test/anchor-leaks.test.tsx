// @vitest-environment jsdom
// Утечки замера якоря: ResizeObserver и resize-слушатель должны сниматься при
// смене target и размонтировании, иначе кольца держат закрытые узлы.
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RelayRings } from "../components/relay-rings";
import type { RelayAccount } from "../lib/relay-accounts";

const accounts: RelayAccount[] = [
  { auth_index: "kimi:1", provider: "kimi", disabled: false, quotas: [{ quota_key: "5h", percent: 63 }] },
];

const rpc = () => ({
  call: vi.fn(async (method: string) => {
    if (method === "providers_list") return { providers: [{ id: "p", baseUrl: "http://relay:4010/v1" }] };
    if (method === "relay_accounts") return { configured: true, items: accounts };
    return {};
  }),
});

const state = { selected: ["http://relay:4010|kimi:1"], size: 40, perRow: 1 };

class SpyResizeObserver {
  static instances: SpyResizeObserver[] = [];
  disconnected = false;
  observed: Element[] = [];
  constructor(public callback: ResizeObserverCallback) {
    SpyResizeObserver.instances.push(this);
  }
  observe(element: Element) {
    this.observed.push(element);
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
}

let realResizeObserver: typeof ResizeObserver | undefined;

beforeEach(() => {
  realResizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = SpyResizeObserver as unknown as typeof ResizeObserver;
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  SpyResizeObserver.instances = [];
  if (realResizeObserver === undefined) delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  else globalThis.ResizeObserver = realResizeObserver;
});

describe("anchor measurement leaks", () => {
  it("observes the anchor, then disconnects on target change and unmount", async () => {
    const removeSpy = vi.spyOn(window, "removeEventListener");
    try {
      const first = document.createElement("div");
      const second = document.createElement("div");
      document.body.append(first, second);
      const stub = rpc();
      const { rerender, unmount } = render(<RelayRings rpc={stub} state={state} target={first} />);
      await waitFor(() => expect(SpyResizeObserver.instances).toHaveLength(1));
      expect(SpyResizeObserver.instances[0]!.observed).toEqual([first]);
      expect(SpyResizeObserver.instances[0]!.disconnected).toBe(false);

      rerender(<RelayRings rpc={stub} state={state} target={second} />);
      await waitFor(() => expect(SpyResizeObserver.instances).toHaveLength(2));
      expect(SpyResizeObserver.instances[0]!.disconnected).toBe(true);
      expect(SpyResizeObserver.instances[1]!.observed).toEqual([second]);

      unmount();
      expect(SpyResizeObserver.instances[1]!.disconnected).toBe(true);
      expect(removeSpy.mock.calls.filter(([type]) => type === "resize")).toHaveLength(2);
    } finally {
      removeSpy.mockRestore();
    }
  });

  it("drops the previous measurement when the anchor disappears", async () => {
    const anchor = document.createElement("div");
    document.body.append(anchor);
    const stub = rpc();
    const { rerender } = render(<RelayRings rpc={stub} state={state} target={anchor} />);
    await waitFor(() => expect(SpyResizeObserver.instances).toHaveLength(1));

    rerender(<RelayRings rpc={stub} state={state} target={null} />);
    await waitFor(() => expect(SpyResizeObserver.instances[0]!.disconnected).toBe(true));
    // без якоря не рисуем и новые наблюдатели не заводим
    expect(SpyResizeObserver.instances).toHaveLength(1);
    expect(document.querySelector(".relay-rings-list")).toBeNull();
  });

  it("does not observe anything while no account is selected", async () => {
    const anchor = document.createElement("div");
    document.body.append(anchor);
    render(<RelayRings rpc={rpc()} state={{ selected: [], size: 40, perRow: 1 }} target={anchor} />);
    await waitFor(() => expect(SpyResizeObserver.instances).toHaveLength(1));
    // один наблюдатель на якорь: выбранных аккаунтов нет — только замер, без RPC
    expect(anchor.querySelector(".relay-rings-list")).toBeNull();
  });
});
