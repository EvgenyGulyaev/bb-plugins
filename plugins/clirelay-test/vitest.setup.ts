import { configure } from "@testing-library/react";

configure({ asyncUtilTimeout: 8_000 });

// React resolves to its production build when the shell exports
// NODE_ENV=production; Testing Library needs `act`.
process.env.NODE_ENV = "test";

// Radix popovers resolve a responsive layout through matchMedia, which jsdom
// does not implement. Default to the desktop (non-compact) branch.
if (typeof window !== "undefined" && !window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  });
}

// floating-ui observes its anchor with ResizeObserver; jsdom has none.
class TestResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= TestResizeObserver as unknown as typeof ResizeObserver;
