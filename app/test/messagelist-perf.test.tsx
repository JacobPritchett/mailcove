// Rows are cheap: a poll or a move of the selection re-renders only the rows
// that changed, and a row's menus are mounted when it is first approached.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import MessageList from "../components/MessageList";
import type { ThreadListRow } from "../lib/types";

// Every row renders one checkbox, so its render count is the row's.
const renders = vi.hoisted(() => ({ byLabel: new Map<string, number>() }));
vi.mock("../components/ui/checkbox", () => ({
  Checkbox: (props: { "aria-label": string; checked: boolean; onClick?: (e: React.MouseEvent) => void }) => {
    renders.byLabel.set(props["aria-label"], (renders.byLabel.get(props["aria-label"]) ?? 0) + 1);
    return <button type="button" role="checkbox" aria-checked={props.checked} aria-label={props["aria-label"]} onClick={props.onClick} />;
  },
}));
vi.mock("../lib/api", () => ({
  ApiError: class ApiError extends Error {},
  listThreads: vi.fn(),
  mutateThreads: vi.fn(() => Promise.resolve({ ok: true, count: 0 })),
  mutateThread: vi.fn(() => Promise.resolve({ ok: true })),
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }),
}));

import { listThreads } from "../lib/api";

const N = 30;
const rows = (): ThreadListRow[] =>
  Array.from({ length: N }, (_, i) => ({
    thread_id: `t${i + 1}`, id: `m${i + 1}`, msg_from: `Sender ${i + 1} <s${i + 1}@example.com>`, msg_to: "me@example.com",
    subject: `Thread ${i + 1}`, snippet: "s", date: Date.UTC(2026, 9, 1) - i * 60_000, count: 1, anyUnread: 0,
    hasAttachments: 0, starred: 0, category: null,
  })) as ThreadListRow[];

let setSelected: (id: string) => void;
let toggle: (id: string) => void;
function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Harness() {
    const [selected, select] = useState<string | null>(null);
    const [ids, setIds] = useState<Set<string>>(new Set());
    setSelected = select;
    toggle = (id) =>
      setIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    return (
      <MessageList
        view="inbox"
        selectedThreadId={selected}
        // New functions on every render, as App's are.
        onSelect={(id) => select(id)}
        selectedIds={ids}
        onToggleSelect={(id) => toggle(id)}
        onAction={() => {}}
      />
    );
  }
  render(<QueryClientProvider client={qc}><Harness /></QueryClientProvider>);
  return qc;
}
const total = () => [...renders.byLabel.values()].reduce((a, b) => a + b, 0);
const rendered = (since: Map<string, number>) =>
  [...renders.byLabel].filter(([label, n]) => n !== since.get(label)).map(([label]) => label.replace("Select thread: ", ""));
const snapshot = () => new Map(renders.byLabel);

beforeEach(() => {
  vi.clearAllMocks();
  renders.byLabel.clear();
  // A fresh array of fresh objects each time, as a real response is.
  vi.mocked(listThreads).mockImplementation(async () => ({ threads: rows(), unread: 0, user: "me", nextCursor: null }) as never);
});

describe("row rendering", () => {
  it("a poll that changes nothing re-renders no row", async () => {
    const qc = setup();
    await screen.findByText("Thread 1");
    const before = total();
    await act(async () => {
      await qc.refetchQueries({ queryKey: ["threads"] });
    });
    expect(listThreads).toHaveBeenCalledTimes(2);
    // Give the cache time to tell its observers (it does so on a timer).
    await act(() => new Promise<void>((r) => setTimeout(r, 50)));
    expect(total()).toBe(before);
  });

  it("a poll that changes one row re-renders that row only", async () => {
    const qc = setup();
    await screen.findByText("Thread 1");
    const before = snapshot();
    vi.mocked(listThreads).mockImplementation(async () => {
      const next = rows();
      next[4] = { ...next[4], anyUnread: 1 };
      return { threads: next, unread: 0, user: "me", nextCursor: null } as never;
    });
    await act(async () => {
      await qc.refetchQueries({ queryKey: ["threads"] });
    });
    // The cache tells its observers on a timer, a moment after the fetch settles.
    await waitFor(() => expect(rendered(before)).toEqual(["Thread 5"]));
    expect(within(screen.getByText("Thread 5").closest("button")!).getByText("Unread.")).toBeInTheDocument();
  });

  it("moving the selection re-renders the row that lost it and the row that gained it", async () => {
    setup();
    await screen.findByText("Thread 1");
    act(() => setSelected("t3"));
    const before = snapshot();
    act(() => setSelected("t4"));
    expect(rendered(before).sort()).toEqual(["Thread 3", "Thread 4"]);
  });

  it("ticking one checkbox re-renders one row", async () => {
    setup();
    await screen.findByText("Thread 1");
    const before = snapshot();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select thread: Thread 7" }));
    expect(rendered(before)).toEqual(["Thread 7"]);
    expect(screen.getByRole("checkbox", { name: "Select thread: Thread 7" })).toHaveAttribute("aria-checked", "true");
  });

  it("still calls the handler App passed on its latest render, not a stale one", async () => {
    setup();
    await screen.findByText("Thread 1");
    fireEvent.click(screen.getByText("Thread 9"));
    await waitFor(() => expect(screen.getByText("Thread 9").closest("button")).toHaveAttribute("aria-current", "true"));
    fireEvent.click(screen.getByText("Thread 2"));
    await waitFor(() => expect(screen.getByText("Thread 2").closest("button")).toHaveAttribute("aria-current", "true"));
    expect(screen.getByText("Thread 9").closest("button")).not.toHaveAttribute("aria-current");
  });
});

describe("row menus are mounted on demand", () => {
  const row = (n: number) => screen.getByText(`Thread ${n}`).closest("li")!;
  const mounted = (el: HTMLElement) => el.querySelectorAll('[data-slot="dropdown-menu-trigger"]').length;

  it("no row mounts a menu until it is approached, and the buttons are there and named all the same", async () => {
    setup();
    await screen.findByText("Thread 1");
    expect(document.querySelectorAll('[data-slot="dropdown-menu-trigger"]')).toHaveLength(0);
    const r = row(3);
    expect(within(r).getByRole("button", { name: "Archive" })).toBeInTheDocument();
    expect(within(r).getByRole("button", { name: "Snooze" })).toHaveAttribute("aria-haspopup", "menu");
    expect(within(r).getByRole("button", { name: "More actions for Thread 3" })).toHaveAttribute("aria-expanded", "false");
  });

  it("the pointer coming to a row mounts that row's menus and no other's", async () => {
    setup();
    await screen.findByText("Thread 1");
    fireEvent.pointerEnter(row(3).firstElementChild!, { pointerType: "mouse" });
    expect(mounted(row(3))).toBe(2);
    expect(mounted(row(4))).toBe(0);
  });

  it("a touch does not mount them: on a phone they are never shown", async () => {
    setup();
    await screen.findByText("Thread 1");
    fireEvent.pointerEnter(row(3).firstElementChild!, { pointerType: "touch" });
    expect(mounted(row(3))).toBe(0);
  });

  it("focus coming into a row mounts them, so Tab reaches real menus", async () => {
    setup();
    await screen.findByText("Thread 1");
    fireEvent.focus(within(row(5)).getByText("Thread 5").closest("button")!);
    expect(mounted(row(5))).toBe(2);
  });

  it("a click with neither pointer nor focus (a screen reader) opens the menu at once", async () => {
    setup();
    await screen.findByText("Thread 1");
    fireEvent.click(within(row(6)).getByRole("button", { name: "More actions for Thread 6" }));
    expect(await screen.findByRole("menuitem", { name: "Mark as unread" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Report junk" })).toBeInTheDocument();
  });

  it("Enter on the unmounted Snooze button opens the snooze menu", async () => {
    setup();
    await screen.findByText("Thread 1");
    fireEvent.keyDown(within(row(2)).getByRole("button", { name: "Snooze" }), { key: "Enter" });
    expect(await screen.findByRole("menu")).toBeInTheDocument();
  });
});
