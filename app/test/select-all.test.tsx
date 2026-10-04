// Select all across pages: collecting a whole view's ids (bounded), and the
// offer, the count and the bulk action in the app.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "../App";
import { collectViewIds, SELECT_ALL_MAX } from "../lib/selectAll";

vi.mock("../lib/api", () => ({
  ApiError: class ApiError extends Error {},
  listThreads: vi.fn(),
  listThreadIds: vi.fn(),
  getCounts: vi.fn(),
  mutateThread: vi.fn(() => Promise.resolve({ ok: true })),
  mutateThreads: vi.fn(() => Promise.resolve({ ok: true, count: 0 })),
  getThread: vi.fn(),
  getMe: vi.fn(() => Promise.resolve({ email: "me@example.com" })),
  getIdentities: vi.fn(() => Promise.resolve({ identities: [], defaultLocal: "hello", defaultDomain: "example.com" })),
  listDrafts: vi.fn(() => Promise.resolve({ drafts: [] })),
  attachmentUrl: (id: string, name: string) => `/api/attachments/${id}/${name}`,
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), loading: vi.fn(), dismiss: vi.fn() }),
  Toaster: () => null,
}));

import { toast } from "sonner";
import { listThreads, listThreadIds, getCounts, mutateThreads } from "../lib/api";

const row = (n: number) => ({
  thread_id: `t${n}`, id: `m${n}`, msg_from: "Alice <alice@example.com>", msg_to: "me@example.com",
  subject: `Thread ${n}`, snippet: "s", date: Date.now() - n * 1000, count: 1, anyUnread: 0, hasAttachments: 0,
  starred: 0, category: null,
});
const idsOf = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `t${from + i}`);

describe("collectViewIds", () => {
  it("walks every page, in order, passing the view's own filters and each cursor on", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ ids: idsOf(1, 500), nextCursor: "c1" })
      .mockResolvedValueOnce({ ids: idsOf(501, 1000), nextCursor: "c2" })
      .mockResolvedValueOnce({ ids: idsOf(1001, 1240), nextCursor: null });
    const got = await collectViewIds({ view: "inbox", q: "", category: "updates", domain: "example.com" }, fetchPage);
    expect(got).toEqual({ ids: idsOf(1, 1240), capped: false });
    expect(fetchPage.mock.calls.map((c) => c[0].cursor)).toEqual([null, "c1", "c2"]);
    expect(fetchPage.mock.calls[2][0]).toMatchObject({ view: "inbox", category: "updates", domain: "example.com" });
  });

  it("drops an id a page repeats", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ ids: ["a", "b"], nextCursor: "c1" })
      .mockResolvedValueOnce({ ids: ["b", "c"], nextCursor: null });
    expect((await collectViewIds({ view: "all" }, fetchPage)).ids).toEqual(["a", "b", "c"]);
  });

  it("stops at the cap and says there was more", async () => {
    let n = 0;
    const fetchPage = vi.fn(async () => {
      const ids = idsOf(n + 1, n + 500);
      n += 500;
      return { ids, nextCursor: `c${n}` };
    });
    const got = await collectViewIds({ view: "all" }, fetchPage);
    expect(got.ids).toHaveLength(SELECT_ALL_MAX);
    expect(got.capped).toBe(true);
    expect(fetchPage).toHaveBeenCalledTimes(SELECT_ALL_MAX / 500);
  });

  it("is not capped when the view ends exactly at the cap", async () => {
    let n = 0;
    const fetchPage = vi.fn(async () => {
      const ids = idsOf(n + 1, n + 500);
      n += 500;
      return { ids, nextCursor: n === SELECT_ALL_MAX ? null : `c${n}` };
    });
    expect((await collectViewIds({ view: "all" }, fetchPage)).capped).toBe(false);
  });

  it("does not loop on a server that keeps handing out cursors and nothing else", async () => {
    const fetchPage = vi.fn(async () => ({ ids: [] as string[], nextCursor: "again" }));
    expect(await collectViewIds({ view: "all" }, fetchPage)).toEqual({ ids: [], capped: false });
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("fails as a whole when a page fails: a partial set is never acted on", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ ids: ["a"], nextCursor: "c1" })
      .mockRejectedValueOnce(new Error("offline"));
    await expect(collectViewIds({ view: "all" }, fetchPage)).rejects.toThrow("offline");
  });
});

describe("select all in the app", () => {
  function renderApp() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(<QueryClientProvider client={qc}><App /></QueryClientProvider>);
  }
  const selectLoaded = async () => {
    await screen.findByText("Thread 1");
    fireEvent.keyDown(document, { key: "*" });
    fireEvent.keyDown(document, { key: "a" });
  };
  const bar = () => screen.getByRole("toolbar", { name: "Actions for the selected conversations" });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listThreads).mockResolvedValue({
      threads: [row(1), row(2), row(3)], unread: 0, user: "me", nextCursor: "d.1.t3",
    } as never);
    vi.mocked(getCounts).mockResolvedValue({ inbox: 1240, starred: 0, sent: 0, all: 1300, trash: 0, spam: 0, snoozed: 0, inboxUnread: 0 } as never);
    vi.mocked(listThreadIds)
      .mockReset()
      .mockResolvedValueOnce({ ids: idsOf(1, 500), nextCursor: "c1" })
      .mockResolvedValueOnce({ ids: idsOf(501, 1000), nextCursor: "c2" })
      .mockResolvedValueOnce({ ids: idsOf(1001, 1240), nextCursor: null });
    vi.mocked(mutateThreads).mockResolvedValue({ ok: true, count: 0 });
  });

  it("offers the whole view once every loaded row is selected and more exist, with the count", async () => {
    renderApp();
    await selectLoaded();
    expect(within(bar()).getByText("3 selected")).toBeInTheDocument();
    expect(screen.getByText("The 3 loaded so far are selected.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Select all 1,240 in this view" }));
    expect(within(bar()).getByText("All 1,240 selected")).toBeInTheDocument();
    expect(screen.getByText("All 1,240 conversations in this view are selected.")).toBeInTheDocument();
    // Nothing has been fetched or changed by selecting.
    expect(listThreadIds).not.toHaveBeenCalled();
    expect(mutateThreads).not.toHaveBeenCalled();
  });

  it("makes no offer when only some rows are selected, or when everything is already loaded", async () => {
    renderApp();
    await screen.findByText("Thread 1");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select thread: Thread 1" }));
    expect(screen.queryByRole("button", { name: /^Select all/ })).toBeNull();
  });

  it("makes no offer when the loaded rows are the whole view", async () => {
    vi.mocked(listThreads).mockResolvedValue({ threads: [row(1), row(2)], unread: 0, user: "me", nextCursor: null } as never);
    renderApp();
    await selectLoaded();
    expect(within(bar()).getByText("2 selected")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Select all/ })).toBeNull();
  });

  it("applies a bulk action to every conversation in the view, as one action with one toast", async () => {
    renderApp();
    await selectLoaded();
    fireEvent.click(screen.getByRole("button", { name: "Select all 1,240 in this view" }));
    fireEvent.click(within(bar()).getByRole("button", { name: "Archive selected" }));
    await waitFor(() => expect(mutateThreads).toHaveBeenCalledTimes(1));
    expect(listThreadIds).toHaveBeenCalledTimes(3);
    expect(listThreadIds).toHaveBeenNthCalledWith(1, expect.objectContaining({ view: "inbox", cursor: null }));
    const [ids, action] = vi.mocked(mutateThreads).mock.calls[0];
    expect(action).toBe("archive");
    expect(ids).toEqual(idsOf(1, 1240));
    expect(toast).toHaveBeenCalledWith("1,240 archived", expect.objectContaining({ action: expect.objectContaining({ label: "Undo" }) }));
    // The selection is over.
    expect(screen.queryByRole("toolbar", { name: "Actions for the selected conversations" })).toBeNull();
  });

  it("changes nothing when the view cannot be read", async () => {
    vi.mocked(listThreadIds).mockReset().mockRejectedValue(new Error("offline"));
    renderApp();
    await selectLoaded();
    fireEvent.click(screen.getByRole("button", { name: "Select all 1,240 in this view" }));
    fireEvent.click(within(bar()).getByRole("button", { name: "Archive selected" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't read the whole view. Nothing was changed.", expect.anything()),
    );
    expect(mutateThreads).not.toHaveBeenCalled();
  });

  it("goes back to the loaded rows when one of them is unticked", async () => {
    renderApp();
    await selectLoaded();
    fireEvent.click(screen.getByRole("button", { name: "Select all 1,240 in this view" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select thread: Thread 2" }));
    expect(within(bar()).getByText("2 selected")).toBeInTheDocument();
    fireEvent.click(within(bar()).getByRole("button", { name: "Archive selected" }));
    await waitFor(() => expect(mutateThreads).toHaveBeenCalledTimes(1));
    expect(vi.mocked(mutateThreads).mock.calls[0][0]).toEqual(["t1", "t3"]);
    expect(listThreadIds).not.toHaveBeenCalled();
  });

  it("makes the offer without a number where the size of the view is not known (a label filter)", async () => {
    renderApp();
    await screen.findByText("Thread 1");
    fireEvent.click(screen.getByRole("button", { name: "Updates" }));
    await waitFor(() => expect(listThreads).toHaveBeenCalledWith(expect.objectContaining({ category: "updates" })));
    await selectLoaded();
    fireEvent.click(await screen.findByRole("button", { name: "Select all in this view" }));
    expect(within(bar()).getByText("All selected")).toBeInTheDocument();
    fireEvent.click(within(bar()).getByRole("button", { name: "Mark selected as read" }));
    await waitFor(() => expect(mutateThreads).toHaveBeenCalledTimes(1));
    expect(listThreadIds).toHaveBeenNthCalledWith(1, expect.objectContaining({ view: "inbox", category: "updates" }));
  });

  it("Clear selection in the banner ends it", async () => {
    renderApp();
    await selectLoaded();
    fireEvent.click(screen.getByRole("button", { name: "Select all 1,240 in this view" }));
    const banner = screen.getByText("All 1,240 conversations in this view are selected.").parentElement!;
    fireEvent.click(within(banner).getByRole("button", { name: "Clear selection" }));
    expect(screen.queryByRole("toolbar", { name: "Actions for the selected conversations" })).toBeNull();
  });
});
