import { configure } from "@testing-library/react";

configure({ asyncUtilTimeout: 8_000 });

// Radix menus scroll the highlighted item into view when their portal opens.
// jsdom does not implement this browser API.
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: () => {},
  });
}

// The vendored popover resolves a responsive layout through matchMedia, which
// jsdom does not implement. Default to the non-compact (desktop) branch.
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
globalThis.ResizeObserver ??=
  TestResizeObserver as unknown as typeof ResizeObserver;

// Radix context menus track the pointer through capture APIs jsdom omits.
if (typeof Element !== "undefined") {
  const elementPrototype = Element.prototype as Element & {
    hasPointerCapture?: (pointerId: number) => boolean;
    setPointerCapture?: (pointerId: number) => void;
    releasePointerCapture?: (pointerId: number) => void;
  };
  elementPrototype.hasPointerCapture ??= () => false;
  elementPrototype.setPointerCapture ??= () => {};
  elementPrototype.releasePointerCapture ??= () => {};
}
