/**
 * Touch gestures on list rows, long-press selection, and the bulk bar.
 * (jsdom has no layout, so a row is 0px wide and the commit threshold sits at
 * its floor of 56px. The real distances are checked in e2e-mobile-list.)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import MessageList from "../components/MessageList";
import BulkActionBar from "../components/BulkActionBar";
import { useRef } from "react";
import { createPortal } from "react-dom";
import { EDGE_PX, LONG_PRESS_MS, commitThreshold, decideAxis, swipeOutcome, useRowGestures } from "../lib/rowGestures";
import { PULL_THRESHOLD_PX, pullDistance } from "../lib/usePullToRefresh";
import type { ThreadListRow, View } from "../lib/types";

vi.mock("../lib/api", () => ({
  ApiError: class ApiError extends Error { status = 0; },
  listThreads: vi.fn(),
  mutateThread: vi.fn(() => Promise.resolve({ ok: true })),
  mutateThreads: vi.fn(() => Promise.resolve({ ok: true, count: 0 })),
  getThread: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), dismiss: vi.fn() }) }));

import { listThreads } from "../lib/api";

const ROW: ThreadListRow = {
  thread_id: "t1", id: "m1", msg_from: "Alice <alice@example.com>", msg_to: "me@example.com",
  subject: "Lunch", snippet: "hi", date: Date.now(), count: 1, anyUnread: 0, hasAttachments: 0,
  starred: 0, category: null,
};

function setTouch(touch: boolean) {
  window.matchMedia = ((query: string) =>
    ({
      matches: /pointer:\s*coarse/.test(query) ? touch : /min-width:\s*768px/.test(query) ? !touch : false,
      media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
}

function renderList(view: View = "inbox", selected: string[] = []) {
  const onAction = vi.fn();
  const onSelect = vi.fn();
  const onToggleSelect = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MessageList
        view={view}
        selectedThreadId={null}
        onSelect={onSelect}
        onAction={onAction}
        selectedIds={new Set(selected)}
        onToggleSelect={onToggleSelect}
      />
    </QueryClientProvider>,
  );
  return { onAction, onSelect, onToggleSelect };
}
/** The element that slides: the row button's parent. */
async function slideOf(subject = "Lunch") {
  const button = (await screen.findByText(subject)).closest('[data-slot="thread-row"]') as HTMLElement;
  return { slide: button.parentElement as HTMLElement, button };
}
const touchPoint = (x: number, y: number) => ({ pointerId: 7, pointerType: "touch", isPrimary: true, clientX: x, clientY: y });
function drag(el: HTMLElement, path: [number, number][], release = true) {
  fireEvent.pointerDown(el, touchPoint(...path[0]));
  for (const p of path.slice(1)) fireEvent.pointerMove(el, touchPoint(...p));
  if (release) fireEvent.pointerUp(el, touchPoint(...path[path.length - 1]));
}

beforeEach(() => {
  vi.clearAllMocks();
  setTouch(true);
  vi.mocked(listThreads).mockResolvedValue({ threads: [ROW, { ...ROW, thread_id: "t2", subject: "Second" }], unread: 0, user: "me" });
});
afterEach(() => {
  vi.useRealTimers();
  setTouch(false);
});

describe("deciding the gesture", () => {
  it("waits for real movement before choosing an axis", () => {
    expect(decideAxis(4, 3)).toBeNull();
    expect(decideAxis(9, 9)).toBeNull();
  });

  it("is horizontal only when sideways clearly wins; a diagonal stays a scroll", () => {
    expect(decideAxis(20, 4)).toBe("horizontal");
    expect(decideAxis(-20, 4)).toBe("horizontal");
    expect(decideAxis(4, 20)).toBe("vertical");
    expect(decideAxis(14, 12)).toBe("vertical");
  });

  it("commits past about a third of the row, capped so a wide row is not a long haul", () => {
    expect(commitThreshold(390)).toBe(120);
    expect(commitThreshold(300)).toBe(105);
    expect(commitThreshold(1200)).toBe(120);
    expect(swipeOutcome(119, 390)).toBeNull();
    expect(swipeOutcome(120, 390)).toBe("right");
    expect(swipeOutcome(-200, 390)).toBe("left");
  });

  it("damps a pull, ignores the first few pixels, and stops following at the end", () => {
    expect(pullDistance(5)).toBe(0);
    expect(pullDistance(10 + 2 * PULL_THRESHOLD_PX)).toBe(PULL_THRESHOLD_PX);
    expect(pullDistance(5000)).toBe(96);
  });
});

describe("swiping a row", () => {
  it("right archives it, through the same action path as everything else", async () => {
    const { onAction, onSelect } = renderList();
    const { slide, button } = await slideOf();
    drag(slide, [[20, 100], [50, 102], [140, 104]]);
    expect(onAction).toHaveBeenCalledWith(["t1"], "archive");
    // The release is not also a tap on the row.
    fireEvent.click(button);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("left moves it to trash", async () => {
    const { onAction } = renderList();
    const { slide } = await slideOf();
    drag(slide, [[300, 100], [260, 101], [150, 99]]);
    expect(onAction).toHaveBeenCalledWith(["t1"], "trash");
  });

  it("follows the finger and tells the underlay which way, and when letting go would commit", async () => {
    renderList();
    const { slide } = await slideOf();
    const underlay = slide.previousElementSibling as HTMLElement;
    drag(slide, [[100, 100], [130, 100]], false);
    expect(slide.style.transform).toBe("translate3d(30px,0,0)");
    expect(underlay.dataset.dir).toBe("right");
    expect(underlay.dataset.armed).toBe("false");
    fireEvent.pointerMove(slide, touchPoint(170, 100));
    expect(underlay.dataset.armed).toBe("true");
    fireEvent.pointerMove(slide, touchPoint(20, 100));
    expect(underlay.dataset.dir).toBe("left");
    expect(underlay.getAttribute("aria-hidden")).toBe("true");
  });

  it("snaps back, doing nothing, when released short of the threshold", async () => {
    const { onAction } = renderList();
    const { slide } = await slideOf();
    drag(slide, [[100, 100], [130, 100], [140, 100]]);
    expect(onAction).not.toHaveBeenCalled();
    expect(slide.style.transform).toBe("");
  });

  it("leaves a vertical drag to the scroller, even if it drifts sideways afterwards", async () => {
    const { onAction } = renderList();
    const { slide } = await slideOf();
    drag(slide, [[100, 100], [103, 130], [220, 200]]);
    expect(onAction).not.toHaveBeenCalled();
    expect(slide.style.transform).toBe("");
  });

  it("snaps back when the browser takes the gesture over", async () => {
    const { onAction } = renderList();
    const { slide } = await slideOf();
    drag(slide, [[100, 100], [200, 100]], false);
    fireEvent.pointerCancel(slide, touchPoint(200, 100));
    expect(onAction).not.toHaveBeenCalled();
    expect(slide.style.transform).toBe("");
  });

  it("ignores a mouse", async () => {
    const { onAction } = renderList();
    const { slide } = await slideOf();
    const mouse = (x: number) => ({ pointerId: 1, pointerType: "mouse", isPrimary: true, clientX: x, clientY: 100 });
    fireEvent.pointerDown(slide, mouse(20));
    fireEvent.pointerMove(slide, mouse(200));
    fireEvent.pointerUp(slide, mouse(200));
    expect(onAction).not.toHaveBeenCalled();
    expect(slide.style.transform).toBe("");
  });

  it("in Trash either direction restores, and in Junk either direction is Not junk", async () => {
    const trash = renderList("trash");
    let { slide } = await slideOf();
    drag(slide, [[20, 100], [140, 100]]);
    ({ slide } = await slideOf("Second"));
    drag(slide, [[300, 100], [150, 100]]);
    expect(trash.onAction.mock.calls).toEqual([[["t1"], "restore"], [["t2"], "restore"]]);
  });

  it("in Junk either direction is Not junk", async () => {
    const junk = renderList("spam");
    const { slide } = await slideOf();
    drag(slide, [[300, 100], [150, 100]]);
    expect(junk.onAction).toHaveBeenCalledWith(["t1"], "unspam");
  });

  it("slides back when the action leaves the row listed (archiving in All Mail)", async () => {
    const { onAction } = renderList("all");
    const { slide } = await slideOf();
    drag(slide, [[20, 100], [140, 100]]);
    expect(onAction).toHaveBeenCalledWith(["t1"], "archive");
    expect(slide.style.transform).toBe("");
  });

  it("is off while selecting", async () => {
    const { onAction } = renderList("inbox", ["t2"]);
    const { slide } = await slideOf();
    drag(slide, [[20, 100], [140, 100]]);
    expect(onAction).not.toHaveBeenCalled();
  });

  it("uses no transition when the user asked for reduced motion", async () => {
    const coarse = window.matchMedia;
    window.matchMedia = ((q: string) =>
      /prefers-reduced-motion/.test(q) ? ({ ...coarse(q), matches: true } as MediaQueryList) : coarse(q)) as typeof window.matchMedia;
    renderList();
    const { slide } = await slideOf();
    drag(slide, [[100, 100], [130, 100], [135, 100]]);
    expect(slide.style.transition).toBe("none");
    window.matchMedia = coarse;
    drag(slide, [[100, 100], [130, 100], [135, 100]]);
    expect(slide.style.transition).toContain("transform");
  });
});

describe("what is not a swipe on the row", () => {
  it("a swipe that starts at either screen edge (the browser's own gestures live there)", async () => {
    const { onAction } = renderList();
    const { slide } = await slideOf();
    drag(slide, [[EDGE_PX - 1, 100], [200, 100]]);
    drag(slide, [[window.innerWidth - EDGE_PX + 1, 100], [window.innerWidth - 300, 100]]);
    expect(onAction).not.toHaveBeenCalled();
    expect(slide.style.transform).toBe("");
    // Just inside the margin it is a swipe.
    drag(slide, [[EDGE_PX, 100], [200, 100]]);
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("a drag inside something the row opened (a portalled menu or dialog)", () => {
    const onSwipe = vi.fn(() => false);
    const onLongPress = vi.fn();
    function RowWithPortal() {
      const slide = useRef<HTMLDivElement>(null);
      const underlay = useRef<HTMLDivElement>(null);
      const gestures = useRowGestures(slide, underlay, { swipeEnabled: true, onSwipe, onLongPress });
      return (
        <div>
          <div ref={underlay} />
          <div ref={slide} {...gestures} data-testid="row">
            row
            {createPortal(<div data-testid="menu">Snooze until</div>, document.body)}
          </div>
        </div>
      );
    }
    render(<RowWithPortal />);
    const menu = screen.getByTestId("menu");
    // React hands these to the row's handlers although the menu is elsewhere in the page.
    vi.useFakeTimers();
    drag(menu, [[100, 100], [130, 100], [300, 100]]);
    fireEvent.pointerDown(menu, touchPoint(100, 100));
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    });
    expect(onSwipe).not.toHaveBeenCalled();
    expect(onLongPress).not.toHaveBeenCalled();
    expect(screen.getByTestId("row").style.transform).toBe("");
    // The row itself still swipes.
    drag(screen.getByTestId("row"), [[100, 100], [300, 100]]);
    expect(onSwipe).toHaveBeenCalledWith("right");
  });

  it("nothing lingers after the touch: a later click on the row is not swallowed", async () => {
    const { onSelect, onToggleSelect } = renderList();
    const { slide, button } = await slideOf();
    vi.useFakeTimers();
    fireEvent.pointerDown(slide, touchPoint(100, 100));
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS + 10);
    });
    expect(onToggleSelect).toHaveBeenCalledTimes(1);
    // The finger lifts with no click following (it had drifted off the row).
    fireEvent.pointerUp(slide, touchPoint(100, 100));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    // Much later, a mouse click (or Enter) on the row does what it says.
    fireEvent.click(button);
    expect(onSelect).toHaveBeenCalledWith("t1");
    // And the context menu is the browser's again.
    expect(fireEvent.contextMenu(slide)).toBe(true);
  });
});

describe("selecting on touch", () => {
  it("keeps checkboxes out of sight, and out of the row's layout, until something is selected", async () => {
    renderList();
    const { button } = await slideOf();
    const checkbox = screen.getByRole("checkbox", { name: "Select thread: Lunch" });
    expect(checkbox.parentElement!.className).toContain("sr-only");
    expect(button.className).toContain("pl-4");
    expect(button.className).not.toContain("pl-11");
  });

  it("a long press selects the row; the tap that ends it does not open the thread", async () => {
    const { onToggleSelect, onSelect } = renderList();
    const { slide, button } = await slideOf();
    vi.useFakeTimers();
    fireEvent.pointerDown(slide, touchPoint(100, 100));
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS + 10);
    });
    expect(onToggleSelect).toHaveBeenCalledWith("t1");
    fireEvent.pointerUp(slide, touchPoint(100, 100));
    fireEvent.click(button);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onToggleSelect).toHaveBeenCalledTimes(1);
  });

  it("moving first is not a long press", async () => {
    const { onToggleSelect } = renderList();
    const { slide } = await slideOf();
    vi.useFakeTimers();
    fireEvent.pointerDown(slide, touchPoint(100, 100));
    fireEvent.pointerMove(slide, touchPoint(100, 140));
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    });
    expect(onToggleSelect).not.toHaveBeenCalled();
  });

  it("a quick tap still opens the thread", async () => {
    const { onSelect, onToggleSelect } = renderList();
    const { slide, button } = await slideOf();
    fireEvent.pointerDown(slide, touchPoint(100, 100));
    fireEvent.pointerUp(slide, touchPoint(100, 100));
    fireEvent.click(button);
    expect(onSelect).toHaveBeenCalledWith("t1");
    expect(onToggleSelect).not.toHaveBeenCalled();
  });

  it("while selecting, checkboxes show and a tap toggles instead of opening", async () => {
    const { onSelect, onToggleSelect } = renderList("inbox", ["t2"]);
    const { button } = await slideOf();
    const checkbox = screen.getByRole("checkbox", { name: "Select thread: Lunch" });
    expect(checkbox.parentElement!.className).not.toContain("sr-only");
    expect(button.className).toContain("pl-11");
    fireEvent.click(button);
    expect(onToggleSelect).toHaveBeenCalledWith("t1");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("with a mouse, a click on the row opens it even while others are selected", async () => {
    setTouch(false);
    const { onSelect } = renderList("inbox", ["t2"]);
    const { button } = await slideOf();
    fireEvent.click(button);
    expect(onSelect).toHaveBeenCalledWith("t1");
  });
});

describe("the bulk action bar", () => {
  const labels = () =>
    within(screen.getByRole("toolbar")).getAllByRole("button").map((b) => b.getAttribute("aria-label"));

  it("is icons only, each with a name, leading with the way out", () => {
    render(<BulkActionBar count={3} view="inbox" onAction={() => {}} onClear={() => {}} />);
    expect(labels()).toEqual([
      "Clear selection", "Archive selected", "Move selected to trash", "Mark selected as read",
      "Snooze selected", "More actions for the selection",
    ]);
    for (const b of within(screen.getByRole("toolbar")).getAllByRole("button")) {
      expect(b.textContent).toBe("");
      expect(b.getAttribute("title")).toBe(b.getAttribute("aria-label"));
      expect(b.className).toContain("max-md:size-11");
    }
    expect(screen.getByText("3 selected")).toBeInTheDocument();
  });

  it("keeps the rest under More", async () => {
    const onAction = vi.fn();
    render(<BulkActionBar count={2} view="inbox" onAction={onAction} onClear={() => {}} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "More actions for the selection" }), { key: "Enter" });
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent?.trim())).toEqual([
      "Mark as unread", "Star", "Report junk",
    ]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Mark as unread" }));
    expect(onAction).toHaveBeenCalledWith("unread");
  });

  it("Clear selection is the way out", () => {
    const onClear = vi.fn();
    render(<BulkActionBar count={1} view="inbox" onAction={() => {}} onClear={onClear} />);
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(onClear).toHaveBeenCalled();
  });

  it("offers only what applies in Trash", async () => {
    render(<BulkActionBar count={1} view="trash" onAction={() => {}} onClear={() => {}} />);
    expect(labels()).toEqual(["Clear selection", "Restore selected", "Delete selected forever"]);
    fireEvent.click(screen.getByRole("button", { name: "Delete selected forever" }));
    await waitFor(() => expect(screen.getByRole("alertdialog")).toBeInTheDocument());
  });
});
