// The reader took `now` during render, so a message opened at 23:59 still said
// "11:59 PM" past midnight and a thread left open overnight kept claiming
// "yesterday". Nothing re-rendered it, because nothing about the message
// changed - only the world did.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import RelativeTime from "../components/RelativeTime";

afterEach(() => vi.useRealTimers());

const at = (y: number, m: number, d: number, hh: number, mm = 0) =>
  new Date(y, m, d, hh, mm).getTime();

describe("RelativeTime", () => {
  it("re-renders as the clock crosses midnight, without any prop changing", () => {
    vi.useFakeTimers();
    vi.setSystemTime(at(2026, 6, 21, 23, 59));
    const sent = at(2026, 6, 21, 9, 41);

    render(<RelativeTime date={sent} />);
    // Same calendar day: a bare time.
    expect(screen.getByText(/9:41/)).toBeInTheDocument();

    act(() => {
      vi.setSystemTime(at(2026, 6, 22, 0, 2));
      vi.advanceTimersByTime(120_000);
    });

    // Now yesterday - and the element never received a new `date`.
    expect(screen.getByText(/yesterday/)).toBeInTheDocument();
  });

  it("keeps the exact instant available as a machine-readable attribute", () => {
    vi.useFakeTimers();
    vi.setSystemTime(at(2026, 6, 21, 12));
    const sent = at(2026, 6, 21, 9, 41);

    const { container } = render(<RelativeTime date={sent} />);

    const el = container.querySelector("time")!;
    expect(el.getAttribute("dateTime")).toBe(new Date(sent).toISOString());
  });

  it("stops ticking once unmounted", () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, "clearInterval");
    const { unmount } = render(<RelativeTime date={Date.now()} />);

    unmount();

    expect(spy).toHaveBeenCalled();
  });
});
