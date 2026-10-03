/**
 * The unread count outside the app: the tab title and the app icon badge.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { setUnreadBadge, unreadTitle, useUnreadBadge } from "@/lib/useUnreadBadge";

type Nav = { setAppBadge?: unknown; clearAppBadge?: unknown };
const nav = navigator as unknown as Nav;

beforeEach(() => {
  document.title = "Mailcove";
});
afterEach(() => {
  delete nav.setAppBadge;
  delete nav.clearAppBadge;
});

describe("unreadTitle", () => {
  it("leads with the count when there is unread mail", () => {
    expect(unreadTitle(3, "Mailcove")).toBe("(3) Inbox");
    expect(unreadTitle(120, "Mailcove")).toBe("(120) Inbox");
  });

  it("is the app's own title at zero", () => {
    expect(unreadTitle(0, "Mailcove")).toBe("Mailcove");
  });
});

describe("useUnreadBadge: the tab title", () => {
  it("follows the count up and down, and returns to the original title at zero", () => {
    const { rerender } = renderHook(({ n }: { n: number | undefined }) => useUnreadBadge(n), {
      initialProps: { n: 3 as number | undefined },
    });
    expect(document.title).toBe("(3) Inbox");
    rerender({ n: 4 });
    expect(document.title).toBe("(4) Inbox");
    rerender({ n: 0 });
    expect(document.title).toBe("Mailcove");
  });

  it("leaves the title alone until a count is known, and when it stops being known", () => {
    const { rerender } = renderHook(({ n }: { n: number | undefined }) => useUnreadBadge(n), {
      initialProps: { n: undefined as number | undefined },
    });
    expect(document.title).toBe("Mailcove");
    rerender({ n: 2 });
    expect(document.title).toBe("(2) Inbox");
    // A failed refresh: not the same as zero unread.
    rerender({ n: undefined });
    expect(document.title).toBe("(2) Inbox");
  });

  it("puts the title back when the app goes away", () => {
    const { unmount } = renderHook(() => useUnreadBadge(5));
    expect(document.title).toBe("(5) Inbox");
    unmount();
    expect(document.title).toBe("Mailcove");
  });
});

describe("the app icon badge", () => {
  it("sets the badge to the count and clears it at zero", () => {
    nav.setAppBadge = vi.fn(() => Promise.resolve());
    nav.clearAppBadge = vi.fn(() => Promise.resolve());
    const { rerender } = renderHook(({ n }: { n: number }) => useUnreadBadge(n), { initialProps: { n: 7 } });
    expect(nav.setAppBadge).toHaveBeenCalledWith(7);
    rerender({ n: 0 });
    expect(nav.clearAppBadge).toHaveBeenCalledTimes(1);
  });

  it("does nothing, quietly, where the Badging API does not exist", () => {
    expect(nav.setAppBadge).toBeUndefined();
    expect(() => setUnreadBadge(3)).not.toThrow();
    expect(() => setUnreadBadge(0)).not.toThrow();
  });

  it("swallows a rejection and a synchronous throw", async () => {
    nav.setAppBadge = vi.fn(() => Promise.reject(new Error("NotAllowedError")));
    nav.clearAppBadge = vi.fn(() => {
      throw new Error("SecurityError");
    });
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);
    expect(() => setUnreadBadge(3)).not.toThrow();
    expect(() => setUnreadBadge(0)).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(unhandled).not.toHaveBeenCalled();
    window.removeEventListener("unhandledrejection", unhandled);
  });

  it("is not fooled by a non-function of the same name", () => {
    nav.setAppBadge = true;
    expect(() => setUnreadBadge(3)).not.toThrow();
  });
});
