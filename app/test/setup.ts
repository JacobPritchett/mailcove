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
    // A 1280px window: wide enough for the full sidebar as well (below 1100px
    // it is an icon rail, see useIsWide).
    const min = /min-width:\s*(\d+)px/.exec(query);
    return {
      matches: !!min && Number(min[1]) <= 1280, // desktop by default
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

// Radix (FocusScope) defers part of its unmount work to a zero-delay timer. A
// test that ends with a dialog still open leaves that timer pending; when it
// was the last test in its file, the timer could fire after jsdom had been torn
// down and surface as an unhandled "dispatchEvent ... is not of type 'Event'"
// that failed the run without failing any test. Unmount here and give those
// timers one turn while the window still exists.
import { afterEach, beforeEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// Undo send holds a sent message for ten seconds by default. The suite sends
// mail in dozens of places that are about something else, so it runs with the
// delay off; the tests that are about the hold (outbox, undo-send) turn it on.
beforeEach(() => {
  try {
    localStorage.setItem("mailcove.undo-send", "0");
  } catch {
    // a test that replaced localStorage with something that throws
  }
});

afterEach(async () => {
  cleanup();
  if (vi.isFakeTimers()) return;
  await new Promise((resolve) => setTimeout(resolve, 0));
});
