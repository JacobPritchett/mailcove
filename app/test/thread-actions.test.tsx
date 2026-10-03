// Thread actions across the app: which actions are offered, what `z` undoes,
// what the selection and the keyboard act on, and what happens on failure.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, within, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "../App";

vi.mock("../lib/api", () => ({
  ApiError: class ApiError extends Error {},
  listThreads: vi.fn(),
  getCounts: vi.fn(),
  mutateThread: vi.fn(() => Promise.resolve({ ok: true })),
  mutateThreads: vi.fn(() => Promise.resolve({ ok: true, count: 0 })),
  getThread: vi.fn(),
  getMe: vi.fn(() => Promise.resolve({ email: "me@example.com" })),
  getIdentities: vi.fn(() =>
    Promise.resolve({ identities: [], defaultLocal: "hello", defaultDomain: "example.com" }),
  ),
  send: vi.fn(),
  putDraft: vi.fn(() => Promise.resolve({ ok: true })),
  deleteDraft: vi.fn(() => Promise.resolve({ ok: true })),
  listDrafts: vi.fn(() => Promise.resolve({ drafts: [] })),
  getDraft: vi.fn(),
  attachmentUrl: (id: string, name: string) => `/api/attachments/${id}/${name}`,
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }),
  Toaster: () => null,
}));

import { toast } from "sonner";
import { listThreads, getCounts, getThread, mutateThread, mutateThreads } from "../lib/api";

const row = (id: string, subject: string, domain = "a.com") => ({
  thread_id: id, id: "m" + id, msg_from: "Alice <alice@example.com>", msg_to: "me@example.com",
  subject, snippet: "s", date: Date.now(), count: 1, anyUnread: 0, hasAttachments: 0, starred: 0, category: null, domain,
});
const thread = (id: string) => ({
  thread_id: id,
  messages: [{
    id: "m" + id, thread_id: id, direction: "in", folder: "inbox", msg_from: "Alice <alice@example.com>",
    msg_to: "me@example.com", subject: "Subj " + id, snippet: "s", date: Date.now(), unread: 0,
    has_attachments: 0, msg_cc: null, message_id: "<mid>", in_reply_to: null,
    body: { text: "hello", html: "", attachments: [] },
  }],
});

function renderApp() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { qc, ...render(<QueryClientProvider client={qc}><App /></QueryClientProvider>) };
}

function setViewport(isDesktop: boolean) {
  window.matchMedia = ((query: string) =>
    ({
      matches: /min-width:\s*768px/.test(query) ? isDesktop : !isDesktop,
      media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
}

/** Options of the most recent plain toast() call (the action toast). */
function lastToastOptions() {
  return vi.mocked(toast).mock.calls.at(-1)![1] as {
    id: string;
    action?: { label: string; onClick: () => void };
    onDismiss?: () => void;
    onAutoClose?: () => void;
  };
}

const reader = () => within(screen.getByRole("main"));
const settle = (ms = 40) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listThreads).mockImplementation(async ({ domain }) => ({
    threads: domain === "b.com"
      ? [row("t9", "Thread Z", "b.com")]
      : [row("t1", "Thread A"), row("t2", "Thread B"), row("t3", "Thread C")],
    unread: 0, user: "me",
  }) as never);
  vi.mocked(getCounts).mockResolvedValue({
    inbox: 4, starred: 0, sent: 0, all: 4, trash: 0, inboxUnread: 0,
    domains: [{ domain: "a.com", threads: 3, unread: 0 }, { domain: "b.com", threads: 1, unread: 0 }],
  } as never);
  vi.mocked(getThread).mockImplementation(async (id: string) => thread(id) as never);
  vi.mocked(mutateThread).mockResolvedValue({ ok: true });
  vi.mocked(mutateThreads).mockResolvedValue({ ok: true, count: 0 });
});

afterEach(() => setViewport(true));

describe("multi-select", () => {
  it("is cleared when the domain filter changes", async () => {
    renderApp();
    fireEvent.click(await screen.findByRole("checkbox", { name: /Select thread: Thread A/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Select thread: Thread B/i }));
    expect(screen.getByText("2 selected")).toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: /b\.com/ }));
    await screen.findByText("Thread Z");
    expect(screen.queryByText("2 selected")).not.toBeInTheDocument();
  });
});

describe("searching from the Trash view", () => {
  async function searchInTrash() {
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: /^Trash/ }));
    fireEvent.change(screen.getByLabelText("Search messages"), { target: { value: "thread" } });
    await waitFor(() =>
      expect(listThreads).toHaveBeenCalledWith(expect.objectContaining({ q: "thread" })),
    );
    await screen.findByText("Thread A");
  }

  it("offers live-mail actions on rows, not Restore and Delete forever", async () => {
    await searchInTrash();
    await waitFor(() => expect(screen.queryAllByRole("button", { name: "Delete forever" })).toHaveLength(0));
    expect(screen.queryAllByRole("button", { name: "Restore" })).toHaveLength(0);
    expect(screen.getAllByRole("button", { name: "Archive" }).length).toBeGreaterThan(0);
  });

  it("offers live-mail actions in the reader toolbar and the bulk bar", async () => {
    await searchInTrash();
    fireEvent.click(screen.getByText("Thread A"));
    await screen.findByRole("heading", { name: "Subj t1" });
    expect(reader().getByRole("button", { name: "Move to trash" })).toBeInTheDocument();
    expect(reader().queryByRole("button", { name: "Delete forever" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: /Select thread: Thread B/i }));
    expect(screen.getByRole("button", { name: "Move selected to trash" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete selected forever" })).not.toBeInTheDocument();
  });

  it("lets # trash a search result", async () => {
    await searchInTrash();
    fireEvent.click(screen.getByText("Thread A"));
    await screen.findByRole("heading", { name: "Subj t1" });
    fireEvent.keyDown(document, { key: "#" });
    await waitFor(() => expect(mutateThread).toHaveBeenCalledWith("t1", "trash"));
  });
});

describe("undo with z", () => {
  it("undoes the latest action when that came from the reader toolbar", async () => {
    renderApp();
    fireEvent.click(await screen.findByText("Thread A"));
    await screen.findByRole("heading", { name: "Subj t1" });
    fireEvent.keyDown(document, { key: "s" }); // star t1 by keyboard
    await waitFor(() => expect(mutateThread).toHaveBeenCalledWith("t1", "star"));

    fireEvent.click(screen.getByText("Thread B"));
    await screen.findByRole("heading", { name: "Subj t2" });
    fireEvent.click(reader().getByRole("button", { name: "Move to trash" }));
    await waitFor(() => expect(mutateThread).toHaveBeenCalledWith("t2", "trash"));

    fireEvent.keyDown(document, { key: "z" });
    await waitFor(() => expect(mutateThread).toHaveBeenCalledWith("t2", "restore"));
    expect(mutateThread).not.toHaveBeenCalledWith("t1", "unstar");
  });

  it("undoes a row action", async () => {
    renderApp();
    await screen.findByText("Thread A");
    fireEvent.click(screen.getAllByRole("button", { name: "Archive" })[1]); // Thread B's row
    await waitFor(() => expect(mutateThread).toHaveBeenCalledWith("t2", "archive"));
    fireEvent.keyDown(document, { key: "z" });
    await waitFor(() => expect(mutateThread).toHaveBeenCalledWith("t2", "unarchive"));
  });

  it("undoes a bulk action", async () => {
    renderApp();
    fireEvent.click(await screen.findByRole("checkbox", { name: /Select thread: Thread A/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Select thread: Thread B/i }));
    fireEvent.click(screen.getByRole("button", { name: "Archive selected" }));
    await waitFor(() => expect(mutateThreads).toHaveBeenCalledWith(["t1", "t2"], "archive"));
    fireEvent.keyDown(document, { key: "z" });
    await waitFor(() => expect(mutateThreads).toHaveBeenCalledWith(["t1", "t2"], "unarchive"));
  });

  it("does nothing once the action's toast has closed", async () => {
    renderApp();
    fireEvent.click(await screen.findByText("Thread A"));
    await screen.findByRole("heading", { name: "Subj t1" });
    fireEvent.keyDown(document, { key: "s" });
    await waitFor(() => expect(mutateThread).toHaveBeenCalledWith("t1", "star"));

    act(() => lastToastOptions().onAutoClose?.());
    fireEvent.keyDown(document, { key: "z" });
    await settle();
    expect(mutateThread).not.toHaveBeenCalledWith("t1", "unstar");
  });

  it("an older toast closing does not expire a newer action", async () => {
    renderApp();
    fireEvent.click(await screen.findByText("Thread A"));
    await screen.findByRole("heading", { name: "Subj t1" });
    fireEvent.keyDown(document, { key: "s" });
    await waitFor(() => expect(mutateThread).toHaveBeenCalledWith("t1", "star"));
    const first = lastToastOptions();
    fireEvent.click(reader().getByRole("button", { name: "Mark as unread" }));
    await waitFor(() => expect(mutateThread).toHaveBeenCalledWith("t1", "unread"));

    act(() => first.onDismiss?.());
    fireEvent.keyDown(document, { key: "z" });
    await waitFor(() => expect(mutateThread).toHaveBeenCalledWith("t1", "read"));
  });
});

describe("undo ordering", () => {
  it("waits for the original action to settle before sending its inverse", async () => {
    let resolveArchive!: (v: { ok: true }) => void;
    vi.mocked(mutateThread).mockImplementation((_id, action) =>
      action === "archive" ? new Promise((r) => { resolveArchive = r; }) : Promise.resolve({ ok: true }),
    );
    renderApp();
    await screen.findByText("Thread A");
    fireEvent.click(screen.getAllByRole("button", { name: "Archive" })[0]);
    await waitFor(() => expect(mutateThread).toHaveBeenCalledWith("t1", "archive"));

    fireEvent.keyDown(document, { key: "z" });
    await settle();
    // If unarchive went out now, the slow archive would land after it and win.
    expect(mutateThread).not.toHaveBeenCalledWith("t1", "unarchive");

    await act(async () => resolveArchive({ ok: true }));
    await waitFor(() => expect(mutateThread).toHaveBeenCalledWith("t1", "unarchive"));
  });

  it("sends no inverse at all when the original action failed", async () => {
    let rejectArchive!: (e: Error) => void;
    vi.mocked(mutateThread).mockImplementation((_id, action) =>
      action === "archive" ? new Promise((_r, rej) => { rejectArchive = rej; }) : Promise.resolve({ ok: true }),
    );
    renderApp();
    await screen.findByText("Thread A");
    fireEvent.click(screen.getAllByRole("button", { name: "Archive" })[0]);
    await waitFor(() => expect(mutateThread).toHaveBeenCalledWith("t1", "archive"));
    fireEvent.keyDown(document, { key: "z" });
    await act(async () => rejectArchive(new Error("500")));
    await settle();
    expect(mutateThread).not.toHaveBeenCalledWith("t1", "unarchive");
  });

  it("z uses up the toast's Undo, so the same action cannot be undone twice", async () => {
    renderApp();
    fireEvent.click(await screen.findByText("Thread A"));
    await screen.findByRole("heading", { name: "Subj t1" });
    fireEvent.keyDown(document, { key: "s" });
    await waitFor(() => expect(mutateThread).toHaveBeenCalledWith("t1", "star"));
    const options = lastToastOptions();

    fireEvent.keyDown(document, { key: "z" });
    await waitFor(() => expect(mutateThread).toHaveBeenCalledWith("t1", "unstar"));
    expect(toast.dismiss).toHaveBeenCalledWith(options.id);

    // The toast's own button, clicked late (or the toast still animating out).
    act(() => options.action!.onClick());
    fireEvent.keyDown(document, { key: "z" });
    await settle();
    expect(vi.mocked(mutateThread).mock.calls.filter((c) => c[1] === "unstar")).toHaveLength(1);
  });

  it("the toast's Undo clicked twice undoes once", async () => {
    renderApp();
    fireEvent.click(await screen.findByText("Thread A"));
    await screen.findByRole("heading", { name: "Subj t1" });
    fireEvent.keyDown(document, { key: "s" });
    await waitFor(() => expect(mutateThread).toHaveBeenCalledWith("t1", "star"));
    const options = lastToastOptions();
    act(() => {
      options.action!.onClick();
      options.action!.onClick();
    });
    await waitFor(() => expect(mutateThread).toHaveBeenCalledWith("t1", "unstar"));
    await settle();
    expect(vi.mocked(mutateThread).mock.calls.filter((c) => c[1] === "unstar")).toHaveLength(1);
  });
});

describe("Drafts view", () => {
  it("thread shortcuts do not act on the hidden inbox list", async () => {
    renderApp();
    await screen.findByText("Thread A");
    fireEvent.click(screen.getByRole("button", { name: /^Drafts/ }));
    await screen.findByText(/No drafts/);
    fireEvent.keyDown(document, { key: "j" });
    fireEvent.keyDown(document, { key: "#" });
    fireEvent.keyDown(document, { key: "e" });
    await settle();
    expect(mutateThread).not.toHaveBeenCalled();
    expect(getThread).not.toHaveBeenCalled();
  });
});

describe("a failed thread action", () => {
  it("replaces the optimistic toast with an error", async () => {
    vi.mocked(mutateThread).mockRejectedValue(new Error("403"));
    renderApp();
    await screen.findByText("Thread A");
    fireEvent.click(screen.getAllByRole("button", { name: "Archive" })[0]);
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Archived", expect.anything()));
    const { id } = lastToastOptions();
    expect(id).toBeTruthy();
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Couldn't archive. Try again.",
        expect.objectContaining({ id }),
      ),
    );
    // The failed action is not left behind for z to "undo".
    fireEvent.keyDown(document, { key: "z" });
    await settle();
    expect(mutateThread).not.toHaveBeenCalledWith("t1", "unarchive");
  });

  it("says so for a permanent delete instead of leaving 'Deleted forever' up", async () => {
    vi.mocked(mutateThread).mockRejectedValue(new Error("403"));
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: /^Trash/ }));
    await screen.findByText("Thread A");
    fireEvent.click(screen.getAllByRole("button", { name: "Delete forever" })[0]);
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete forever" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't delete. Try again.", expect.anything()),
    );
  });
});

describe("keyboard archive and trash", () => {
  it("advances to the next thread on desktop, and j carries on from there", async () => {
    renderApp();
    fireEvent.click(await screen.findByText("Thread A"));
    await screen.findByRole("heading", { name: "Subj t1" });
    fireEvent.keyDown(document, { key: "e" });
    await waitFor(() => expect(mutateThread).toHaveBeenCalledWith("t1", "archive"));
    await screen.findByRole("heading", { name: "Subj t2" });
    fireEvent.keyDown(document, { key: "j" });
    await screen.findByRole("heading", { name: "Subj t3" });
  });

  it("falls back to the previous thread when the last one is removed", async () => {
    renderApp();
    fireEvent.click(await screen.findByText("Thread C"));
    await screen.findByRole("heading", { name: "Subj t3" });
    fireEvent.keyDown(document, { key: "#" });
    await waitFor(() => expect(mutateThread).toHaveBeenCalledWith("t3", "trash"));
    await screen.findByRole("heading", { name: "Subj t2" });
  });

  it("returns to the list on mobile instead of leaving an empty reader", async () => {
    setViewport(false);
    renderApp();
    fireEvent.click(await screen.findByText("Thread A"));
    await screen.findByRole("button", { name: /back to list/i });
    fireEvent.keyDown(document, { key: "e" });
    await waitFor(() => expect(mutateThread).toHaveBeenCalledWith("t1", "archive"));
    await waitFor(() => expect(screen.queryByRole("button", { name: /back to list/i })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: /open menu/i })).toBeInTheDocument();
  });
});

describe("a failed list refetch", () => {
  it("keeps the loaded rows and shows a retry notice", async () => {
    const { qc } = renderApp();
    await screen.findByText("Thread A");
    vi.mocked(listThreads).mockRejectedValue(new Error("network error"));
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ["threads"] });
    });
    expect(await screen.findByText(/Couldn't refresh/)).toBeInTheDocument();
    expect(screen.getByText("Thread A")).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't load messages/)).not.toBeInTheDocument();
  });
});
