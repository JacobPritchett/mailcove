/**
 * Paging the thread list: the first page polls and merges, later pages load on
 * demand, and optimistic actions keep working across page boundaries.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { loadMoreThreads, useMutateThreads, useThreads } from "@/lib/queries";
import MessageList from "@/components/MessageList";
import App from "@/App";
import type { ThreadListData } from "@/lib/threadPages";
import type { ThreadListRow, ThreadsResponse } from "@/lib/types";

vi.mock("@/lib/api", () => ({
  ApiError: class ApiError extends Error { status = 0; },
  listThreads: vi.fn(),
  getCounts: vi.fn(() => Promise.resolve({ inbox: 0, starred: 0, sent: 0, all: 0, trash: 0, inboxUnread: 0 })),
  mutateThread: vi.fn(() => Promise.resolve({ ok: true })),
  mutateThreads: vi.fn(() => Promise.resolve({ ok: true, count: 0 })),
  getThread: vi.fn(() => new Promise(() => {})),
  getMe: vi.fn(() => Promise.resolve({ email: "me@example.com" })),
  getIdentities: vi.fn(() => Promise.resolve({ identities: [], defaultLocal: "hello", defaultDomain: "example.com" })),
  attachmentUrl: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), dismiss: vi.fn() }), Toaster: () => null }));

import { listThreads, mutateThread, mutateThreads } from "@/lib/api";

function row(n: number, extra: Partial<ThreadListRow> = {}): ThreadListRow {
  // Higher n is newer, so rows list in descending n.
  return {
    thread_id: `t${n}`, id: `m${n}`, msg_from: "Alice <alice@example.com>", msg_to: "me@example.com",
    subject: `Thread ${n}`, snippet: "s", date: n * 1000, sort_date: n * 1000, count: 1, anyUnread: 0,
    hasAttachments: 0, starred: 0, category: null, ...extra,
  };
}
const page = (ns: number[], nextCursor: string | null): ThreadsResponse => ({
  threads: ns.map((n) => row(n)), unread: 0, user: "me", nextCursor,
});
const KEY = ["threads", "inbox", "", "", ""];
const ids = (qc: QueryClient, key = KEY) => qc.getQueryData<ThreadListData>(key)?.threads.map((t) => t.thread_id);

function makeQc() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}
function wrap(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: qc }, children);
}

/** Serve pages [6,5] -> c1 -> [4,3] -> c2 -> [2,1] -> end, keyed by cursor. */
function servePages() {
  vi.mocked(listThreads).mockImplementation(({ cursor }) => {
    if (!cursor) return Promise.resolve(page([6, 5], "c1"));
    if (cursor === "c1") return Promise.resolve(page([4, 3], "c2"));
    return Promise.resolve(page([2, 1], null));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useThreads paging", () => {
  it("asks for one page of 50 and reports that more exist", async () => {
    servePages();
    const qc = makeQc();
    const { result } = renderHook(() => useThreads("inbox"), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(listThreads).toHaveBeenCalledWith(expect.objectContaining({ view: "inbox", limit: 50 }));
    expect(vi.mocked(listThreads).mock.calls[0][0].cursor).toBeUndefined();
    expect(result.current.hasMore).toBe(true);
  });

  it("fetchMore appends the next page, and the end reports no more", async () => {
    servePages();
    const qc = makeQc();
    const { result } = renderHook(() => useThreads("inbox"), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.data).toBeDefined());

    let added: ThreadListRow[] = [];
    await act(async () => {
      added = await result.current.fetchMore();
    });
    expect(added.map((t) => t.thread_id)).toEqual(["t4", "t3"]);
    expect(ids(qc)).toEqual(["t6", "t5", "t4", "t3"]);
    expect(result.current.hasMore).toBe(true);
    await waitFor(() => expect(result.current.isFetchingMore).toBe(false));

    await act(async () => {
      await result.current.fetchMore();
    });
    expect(ids(qc)).toEqual(["t6", "t5", "t4", "t3", "t2", "t1"]);
    // (The cache is already updated; the hook hears about it a tick later.)
    await waitFor(() => expect(result.current.hasMore).toBe(false));
    // At the true end there is nothing left to ask for.
    const calls = vi.mocked(listThreads).mock.calls.length;
    await act(async () => {
      await result.current.fetchMore();
    });
    expect(vi.mocked(listThreads).mock.calls.length).toBe(calls);
  });

  it("fetches a page once however many callers ask for it", async () => {
    servePages();
    const qc = makeQc();
    qc.setQueryData<ThreadListData>(KEY, page([6, 5], "c1"));
    const a = loadMoreThreads(qc, { view: "inbox" });
    const b = loadMoreThreads(qc, { view: "inbox" });
    expect(qc.getQueryData<ThreadListData>(KEY)?.loadingMore).toBe(true);
    await Promise.all([a, b]);
    expect(listThreads).toHaveBeenCalledTimes(1);
    expect(ids(qc)).toEqual(["t6", "t5", "t4", "t3"]);
    expect(qc.getQueryData<ThreadListData>(KEY)?.loadingMore).toBe(false);
  });

  it("a refetch asks for the first page only and keeps the later pages", async () => {
    servePages();
    const qc = makeQc();
    const { result } = renderHook(() => useThreads("inbox"), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.data).toBeDefined());
    await act(async () => {
      await result.current.fetchMore();
    });

    // New mail arrives; the poll sees it on the first page.
    vi.mocked(listThreads).mockClear();
    vi.mocked(listThreads).mockResolvedValue(page([7, 6], "c1b"));
    await act(async () => {
      await result.current.refetch();
    });
    expect(listThreads).toHaveBeenCalledTimes(1);
    expect(vi.mocked(listThreads).mock.calls[0][0].cursor).toBeUndefined();
    // No duplicates, nothing lost, and the next page still continues after t3.
    expect(ids(qc)).toEqual(["t7", "t6", "t5", "t4", "t3"]);
    expect(qc.getQueryData<ThreadListData>(KEY)?.nextCursor).toBe("c2");
  });

  it("a failed page sets a flag instead of throwing, and a retry clears it", async () => {
    const qc = makeQc();
    qc.setQueryData<ThreadListData>(KEY, page([6, 5], "c1"));
    vi.mocked(listThreads).mockRejectedValueOnce(new Error("offline"));
    expect(await loadMoreThreads(qc, { view: "inbox" })).toEqual([]);
    expect(qc.getQueryData<ThreadListData>(KEY)).toMatchObject({ moreFailed: true, loadingMore: false });

    servePages();
    await loadMoreThreads(qc, { view: "inbox" });
    expect(qc.getQueryData<ThreadListData>(KEY)?.moreFailed).toBe(false);
    expect(ids(qc)).toEqual(["t6", "t5", "t4", "t3"]);
  });
});

describe("optimistic actions across pages", () => {
  it("removes a row from a later page and puts it back in place on undo", async () => {
    const qc = makeQc();
    qc.setQueryData<ThreadListData>(KEY, page([6, 5, 4, 3, 2, 1], "c3"));
    vi.mocked(mutateThread).mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() => useMutateThreads("inbox"), { wrapper: wrap(qc) });

    act(() => {
      result.current.mutate({ threadIds: ["t2"], action: "archive" });
    });
    await waitFor(() => expect(ids(qc)).toEqual(["t6", "t5", "t4", "t3", "t1"]));

    // Undo. The refetch that follows renews only the first page, so the row
    // has to come back from what the removal remembered.
    act(() => {
      result.current.mutate({ threadIds: ["t2"], action: "unarchive" });
    });
    await waitFor(() => expect(ids(qc)).toEqual(["t6", "t5", "t4", "t3", "t2", "t1"]));
    expect(qc.getQueryData<ThreadListData>(KEY)?.nextCursor).toBe("c3");
  });

  it("applies a successful action to the other cached lists too", async () => {
    const qc = makeQc();
    const allKey = ["threads", "all", "", "", ""];
    qc.setQueryData<ThreadListData>(KEY, page([3, 2, 1], null));
    qc.setQueryData<ThreadListData>(allKey, page([3, 2, 1], null));
    vi.mocked(mutateThread).mockResolvedValue({ ok: true });
    const { result } = renderHook(() => useMutateThreads("inbox"), { wrapper: wrap(qc) });

    await act(async () => {
      await result.current.mutateAsync({ threadIds: ["t2"], action: "trash" });
    });
    expect(ids(qc, allKey)).toEqual(["t3", "t1"]);

    // Archiving leaves All Mail alone: archived mail is still listed there.
    await act(async () => {
      await result.current.mutateAsync({ threadIds: ["t3"], action: "archive" });
    });
    expect(ids(qc, allKey)).toEqual(["t3", "t1"]);
  });

  it("an archived thread stays out of the cached Inbox when it is later starred from All Mail", async () => {
    const qc = makeQc();
    const allKey = ["threads", "all", "", "", ""];
    qc.setQueryData<ThreadListData>(KEY, page([6, 5, 4, 3, 2, 1], "c3"));
    qc.setQueryData<ThreadListData>(allKey, page([6, 5, 4, 3, 2, 1], "c3"));
    vi.mocked(mutateThread).mockResolvedValue({ ok: true });
    const inbox = renderHook(() => useMutateThreads("inbox"), { wrapper: wrap(qc) });
    await act(async () => {
      await inbox.result.current.mutateAsync({ threadIds: ["t2"], action: "archive" });
    });
    expect(ids(qc)).toEqual(["t6", "t5", "t4", "t3", "t1"]);

    // Starring is not the undo of archiving: it must not bring the row back.
    const all = renderHook(() => useMutateThreads("all"), { wrapper: wrap(qc) });
    await act(async () => {
      await all.result.current.mutateAsync({ threadIds: ["t2"], action: "star" });
    });
    expect(ids(qc)).toEqual(["t6", "t5", "t4", "t3", "t1"]);
    // The real undo still does.
    await act(async () => {
      await all.result.current.mutateAsync({ threadIds: ["t2"], action: "unarchive" });
    });
    expect(ids(qc)).toEqual(["t6", "t5", "t4", "t3", "t2", "t1"]);
  });

  it("a failed action is rolled back alone: a later, successful one stays applied", async () => {
    const qc = makeQc();
    qc.setQueryData<ThreadListData>(KEY, page([6, 5, 4, 3, 2, 1], "c3"));
    let rejectFirst!: (e: Error) => void;
    vi.mocked(mutateThread)
      .mockImplementationOnce(() => new Promise((_, reject) => (rejectFirst = reject)))
      .mockImplementation(() => Promise.resolve({ ok: true }));
    const { result } = renderHook(() => useMutateThreads("inbox"), { wrapper: wrap(qc) });

    let first!: Promise<unknown>;
    await act(async () => {
      first = result.current.mutateAsync({ threadIds: ["t2"], action: "archive" }).catch(() => "failed");
      await Promise.resolve();
    });
    await waitFor(() => expect(ids(qc)).not.toContain("t2"));
    await act(async () => {
      await result.current.mutateAsync({ threadIds: ["t1"], action: "archive" });
    });
    expect(ids(qc)).toEqual(["t6", "t5", "t4", "t3"]);

    await act(async () => {
      rejectFirst(new Error("500"));
      await first;
    });
    // t2 is back where it was; t1, archived on the server, is not resurrected.
    expect(ids(qc)).toEqual(["t6", "t5", "t4", "t3", "t2"]);
  });

  it("a bulk action that fails part way rolls back only the threads that were not changed", async () => {
    const qc = makeQc();
    const allKey = ["threads", "all", "", "", ""];
    qc.setQueryData<ThreadListData>(KEY, page([4, 3, 2, 1], null));
    qc.setQueryData<ThreadListData>(allKey, page([4, 3, 2, 1], null));
    // The first request (t4, t3) went through; the one carrying t2 and t1 failed.
    vi.mocked(mutateThreads).mockRejectedValue(Object.assign(new Error("502"), { failedIds: ["t2", "t1"] }));
    const { result } = renderHook(() => useMutateThreads("inbox"), { wrapper: wrap(qc) });
    await act(async () => {
      await result.current.mutateAsync({ threadIds: ["t4", "t3", "t2", "t1"], action: "trash" }).catch(() => {});
    });
    expect(ids(qc)).toEqual(["t2", "t1"]);
    // And the two that were trashed leave the other cached lists as well.
    expect(ids(qc, allKey)).toEqual(["t2", "t1"]);
  });

  it("rolling back a failed star restores just that row's star", async () => {
    const qc = makeQc();
    qc.setQueryData<ThreadListData>(KEY, page([2, 1], null));
    vi.mocked(mutateThread).mockRejectedValue(new Error("no"));
    const { result } = renderHook(() => useMutateThreads("inbox"), { wrapper: wrap(qc) });
    await act(async () => {
      await result.current.mutateAsync({ threadIds: ["t2"], action: "star" }).catch(() => {});
    });
    expect(qc.getQueryData<ThreadListData>(KEY)?.threads.map((t) => t.starred)).toEqual([0, 0]);
  });

  it("a rollback does not leave the list looking busy", async () => {
    const qc = makeQc();
    qc.setQueryData<ThreadListData>(KEY, { ...page([2, 1], "c1"), loadingMore: true });
    vi.mocked(mutateThread).mockRejectedValue(new Error("no"));
    const { result } = renderHook(() => useMutateThreads("inbox"), { wrapper: wrap(qc) });
    await act(async () => {
      await result.current.mutateAsync({ threadIds: ["t2"], action: "archive" }).catch(() => {});
    });
    expect(ids(qc)).toEqual(["t2", "t1"]);
    expect(qc.getQueryData<ThreadListData>(KEY)?.loadingMore).toBe(false);
  });
});

describe("MessageList paging", () => {
  // jsdom lays nothing out: give the scroller a size so "near the end" means
  // something, and take it away again afterwards.
  const sizes = { clientHeight: 600, scrollHeight: 0 };
  beforeEach(() => {
    sizes.clientHeight = 600;
    sizes.scrollHeight = 5000;
    for (const prop of ["clientHeight", "scrollHeight"] as const) {
      Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => sizes[prop] });
    }
  });
  afterEach(() => {
    for (const prop of ["clientHeight", "scrollHeight"] as const) {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
    }
  });

  function renderList(qc: QueryClient) {
    return render(
      <QueryClientProvider client={qc}>
        <MessageList view="inbox" selectedThreadId={null} onSelect={() => {}} />
      </QueryClientProvider>,
    );
  }

  it("loads the next page when the scroll position nears the end, and shows a quiet row meanwhile", async () => {
    let release!: (p: ThreadsResponse) => void;
    vi.mocked(listThreads).mockImplementation(({ cursor }) =>
      cursor ? new Promise((r) => { release = r; }) : Promise.resolve(page([6, 5], "c1")),
    );
    const { container } = renderList(makeQc());
    await screen.findByText("Thread 6");
    // Far from the end: one request so far.
    expect(listThreads).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Loading more")).toBeNull();

    const viewport = container.querySelector('[data-slot="scroll-area-viewport"]') as HTMLElement;
    viewport.scrollTop = 4000; // 5000 - 4000 - 600 = 400px from the end
    fireEvent.scroll(viewport);

    expect(await screen.findByText("Loading more")).toBeInTheDocument();
    expect(vi.mocked(listThreads).mock.calls[1][0]).toMatchObject({ cursor: "c1", limit: 50 });

    await act(async () => {
      release(page([4, 3], null));
    });
    expect(await screen.findByText("Thread 3")).toBeInTheDocument();
    // The true end: no loading row, no end marker, and no further request.
    expect(screen.queryByText("Loading more")).toBeNull();
    fireEvent.scroll(viewport);
    expect(listThreads).toHaveBeenCalledTimes(2);
  });

  it("keeps loading while a page does not fill the viewport", async () => {
    servePages();
    sizes.scrollHeight = 300; // shorter than the 600px viewport
    renderList(makeQc());
    expect(await screen.findByText("Thread 1")).toBeInTheDocument();
    expect(listThreads).toHaveBeenCalledTimes(3);
  });

  it("does not page a hidden list", async () => {
    servePages();
    sizes.clientHeight = 0;
    renderList(makeQc());
    await screen.findByText("Thread 6");
    await new Promise((r) => setTimeout(r, 20));
    expect(listThreads).toHaveBeenCalledTimes(1);
  });

  it("offers a retry when a page fails", async () => {
    vi.mocked(listThreads).mockImplementation(({ cursor }) =>
      cursor ? Promise.reject(new Error("offline")) : Promise.resolve(page([6, 5], "c1")),
    );
    sizes.scrollHeight = 300;
    renderList(makeQc());
    expect(await screen.findByText("Couldn't load more.")).toBeInTheDocument();
    const calls = vi.mocked(listThreads).mock.calls.length;
    servePages();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Thread 3")).toBeInTheDocument();
    expect(vi.mocked(listThreads).mock.calls.length).toBeGreaterThan(calls);
  });
});

describe("keyboard across a page boundary", () => {
  it("j on the last loaded row loads the next page and moves onto it", async () => {
    servePages();
    render(
      <QueryClientProvider client={makeQc()}>
        <App />
      </QueryClientProvider>,
    );
    await screen.findByText("Thread 6");
    const current = () => document.querySelector('button[aria-current="true"]')?.textContent ?? "";

    fireEvent.keyDown(document, { key: "j" });
    fireEvent.keyDown(document, { key: "j" });
    await waitFor(() => expect(current()).toContain("Thread 5"));
    expect(screen.queryByText("Thread 4")).toBeNull();

    fireEvent.keyDown(document, { key: "j" });
    await waitFor(() => expect(current()).toContain("Thread 4"));
    expect(vi.mocked(listThreads).mock.calls.some(([a]) => a.cursor === "c1")).toBe(true);
  });
});
