// Mobile Back with stacked overlays, shortcuts behind a confirm dialog, and
// Escape in the search box.
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
  getDraftAttachments: vi.fn(() => Promise.resolve({ attachments: [] })),
  deleteDraft: vi.fn(() => Promise.resolve({ ok: true })),
  listDrafts: vi.fn(() => Promise.resolve({ drafts: [] })),
  listFilters: vi.fn(() => Promise.resolve({ filters: [] })),
  listDomains: vi.fn(() => Promise.resolve({ zones: [] })),
  getContacts: vi.fn(() => Promise.resolve({ contacts: [] })),
  attachmentUrl: (id: string, name: string) => `/api/attachments/${id}/${name}`,
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  Toaster: () => null,
}));

import { listThreads, getCounts, getThread, mutateThread, mutateThreads } from "../lib/api";

const row = (id: string, subject: string) => ({
  thread_id: id, id: "m" + id, msg_from: "Alice <alice@example.com>", msg_to: "me@example.com",
  subject, snippet: "s", date: Date.now(), count: 1, anyUnread: 0, hasAttachments: 0, starred: 0, category: null,
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
  return render(<QueryClientProvider client={qc}><App /></QueryClientProvider>);
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

/** Let jsdom deliver the popstate from any programmatic history.back(). */
const settle = (ms = 50) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listThreads).mockResolvedValue({
    threads: [row("t1", "Thread A"), row("t2", "Thread B")], unread: 0, user: "me",
  } as never);
  vi.mocked(getCounts).mockResolvedValue({ inbox: 2, starred: 0, sent: 0, all: 2, trash: 2, inboxUnread: 0 });
  vi.mocked(getThread).mockImplementation(async (id: string) => thread(id) as never);
});

afterEach(async () => {
  setViewport(true);
  await settle();
});

describe("mobile Back with a dialog open over the reader", () => {
  beforeEach(() => setViewport(false));

  it("closes compose first and leaves the reader showing", async () => {
    renderApp();
    fireEvent.click(await screen.findByText("Thread A"));
    await screen.findByRole("button", { name: /back to list/i });
    fireEvent.click(screen.getAllByRole("button", { name: "Compose" })[0]);
    await screen.findByRole("dialog");
    await settle();

    fireEvent.popState(window);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: /back to list/i })).toBeInTheDocument();

    // The next Back closes the reader.
    await settle();
    fireEvent.popState(window);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /back to list/i })).not.toBeInTheDocument(),
    );
  });

  it("closing compose with its own button does not close the reader underneath", async () => {
    renderApp();
    fireEvent.click(await screen.findByText("Thread A"));
    await screen.findByRole("button", { name: /back to list/i });
    fireEvent.click(screen.getAllByRole("button", { name: "Compose" })[0]);
    const dialog = await screen.findByRole("dialog");
    await settle();

    // Programmatic close unwinds the history entry (a real popstate in jsdom).
    fireEvent.click(within(dialog).getAllByRole("button", { name: "Close" })[0]);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await settle(100);
    expect(screen.getByRole("button", { name: /back to list/i })).toBeInTheDocument();
  });

  it.each([
    ["the shortcut help", () => fireEvent.keyDown(document, { key: "?" })],
    ["the command palette", () => fireEvent.keyDown(document, { key: "k", metaKey: true })],
    ["compose", () => fireEvent.keyDown(document, { key: "c" })],
  ])("Back closes %s instead of leaving the app", async (_name, open) => {
    const push = vi.spyOn(window.history, "pushState");
    renderApp();
    await screen.findByText("Thread A");
    const before = push.mock.calls.length;
    open();
    await screen.findByRole("dialog");
    expect(push.mock.calls.length).toBe(before + 1);

    fireEvent.popState(window);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    push.mockRestore();
  });
});

describe("mobile Back with a confirm dialog open", () => {
  beforeEach(() => setViewport(false));

  it("closes the bulk delete confirm and nothing else", async () => {
    const push = vi.spyOn(window.history, "pushState");
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: /open menu/i }));
    fireEvent.click((await screen.findAllByRole("button", { name: /^Trash/ })).at(-1)!);
    fireEvent.click(await screen.findByRole("checkbox", { name: /Select thread: Thread A/i }));
    await settle();
    const before = push.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Delete selected forever" }));
    await screen.findByRole("alertdialog");
    expect(push.mock.calls.length).toBe(before + 1);

    fireEvent.popState(window);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(screen.getByText("1 selected")).toBeInTheDocument();
    expect(mutateThreads).not.toHaveBeenCalled();
    expect(mutateThread).not.toHaveBeenCalled();
    push.mockRestore();
  });

  it("closes the reader's delete confirm before the reader", async () => {
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: /open menu/i }));
    fireEvent.click((await screen.findAllByRole("button", { name: /^Trash/ })).at(-1)!);
    fireEvent.click(await screen.findByText("Thread A"));
    await screen.findByRole("button", { name: /back to list/i });
    await settle();
    fireEvent.click(within(screen.getByRole("main")).getByRole("button", { name: "Delete forever" }));
    await screen.findByRole("alertdialog");

    fireEvent.popState(window);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: /back to list/i })).toBeInTheDocument();
    expect(mutateThread).not.toHaveBeenCalledWith("t1", "delete");
  });
});

describe("mobile Back follows what is on top, not what opened last", () => {
  beforeEach(() => setViewport(false));
  afterEach(() => Reflect.deleteProperty(navigator, "serviceWorker"));

  it("closes compose before a reader that opened underneath it afterwards", async () => {
    const sw = new EventTarget();
    Object.defineProperty(navigator, "serviceWorker", { value: sw, configurable: true });
    renderApp();
    await screen.findByText("Thread A");
    fireEvent.keyDown(document, { key: "c" });
    await screen.findByRole("dialog");
    await settle();
    // A notification tap selects a thread while compose is open: the reader
    // opens BEHIND the dialog, but registers its history entry later.
    act(() => {
      sw.dispatchEvent(new MessageEvent("message", { data: { type: "open-thread", threadId: "t1" } }));
    });
    await screen.findByRole("heading", { name: "Subj t1", hidden: true });
    await settle();

    fireEvent.popState(window);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: /back to list/i })).toBeInTheDocument();

    await settle();
    fireEvent.popState(window);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /back to list/i })).not.toBeInTheDocument(),
    );
  });
});

describe("shortcuts behind a confirm dialog", () => {
  it("Escape cancels the dialog without clearing the selection, and e/# do nothing", async () => {
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: /^Trash/ }));
    fireEvent.click(await screen.findByRole("checkbox", { name: /Select thread: Thread A/i }));
    expect(screen.getByText("1 selected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete selected forever" }));
    const confirm = await screen.findByRole("alertdialog");

    const cancel = within(confirm).getByRole("button", { name: "Cancel" });
    cancel.focus();
    fireEvent.keyDown(cancel, { key: "e" });
    fireEvent.keyDown(cancel, { key: "#" });
    fireEvent.keyDown(cancel, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(screen.getByText("1 selected")).toBeInTheDocument();
    expect(mutateThread).not.toHaveBeenCalled();
    expect(mutateThreads).not.toHaveBeenCalled();
  });
});

describe("Escape in the search box", () => {
  it("clears a query first, then blurs once it is empty", async () => {
    renderApp();
    await screen.findByText("Thread A");
    const input = screen.getByLabelText("Search messages") as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: "invoice" } });

    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("");
    expect(document.activeElement).toBe(input);

    fireEvent.keyDown(input, { key: "Escape" });
    expect(document.activeElement).not.toBe(input);
  });

  it("does not clear the thread selection as a side effect", async () => {
    renderApp();
    fireEvent.click(await screen.findByRole("checkbox", { name: /Select thread: Thread A/i }));
    const input = screen.getByLabelText("Search messages") as HTMLInputElement;
    input.focus();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.getByText("1 selected")).toBeInTheDocument();
  });
});
