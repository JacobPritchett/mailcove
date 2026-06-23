import "@testing-library/jest-dom/vitest";

// jsdom lacks ResizeObserver, which cmdk (command palette) relies on. Provide a
// no-op shim so components using it can mount under test.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// jsdom doesn't implement scrollIntoView, used by cmdk for active-item scroll.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// jsdom doesn't implement matchMedia. The responsive layout uses
// `useIsDesktop()` (matchMedia('(min-width: 768px)')) to gate the tiny bits of
// mobile-only JS (back nav, mobile app bar). Default the suite to the DESKTOP
// breakpoint so the three-pane layout renders and existing assertions (single
// Inbox/Sent nav, single Compose button, one theme toggle) stay unambiguous.
// Individual tests can override `matches` to exercise the mobile layout.
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList => {
    const isMin768 = /min-width:\s*768px/.test(query);
    return {
      matches: isMin768, // desktop by default
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    } as unknown as MediaQueryList;
  };
}
