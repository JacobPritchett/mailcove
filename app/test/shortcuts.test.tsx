/**
 * Integration tests for the keyboard shortcut wiring in App.
 * Verifies that shortcuts registered in useKeyboardShortcuts reach the correct
 * App-level mutations/state, and that the help dialog opens.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "../App";
import type { ThreadsResponse, ThreadListRow, ThreadResponse, Me } from "../lib/types";

vi.mock("../lib/api", () => ({
  ApiError: class ApiError extends Error {},
  listThreads: vi.fn(),
  getCounts: vi.fn(),
  mutateThread: vi.fn(() => Promise.resolve({ ok: true })),
  mutateThreads: vi.fn(() => Promise.resolve({ ok: true, count: 0 })),
  getThread: vi.fn(),
  getMe: vi.fn(),
  getIdentities: vi.fn(() => Promise.resolve({ identities: [], defaultLocal: "hello", defaultDomain: "example.com" })),
  send: vi.fn(),
  attachmentUrl: (id: string, name: string) => `/api/attachments/${id}/${name}`,
}));

import { listThreads, getCounts, getThread, getMe, mutateThread } from "../lib/api";

const ROW: ThreadListRow = {
  thread_id: "t1",
  id: "m1",
  msg_from: "Alice <alice@example.com>",
  msg_to: "me@example.com",
  subject: "Hello from Alice",
  snippet: "just checking in",
  date: Date.now(),
  count: 1,
  anyUnread: 1,
  hasAttachments: 0,
  starred: 0,
  category: null,
};

const THREADS_RESP: ThreadsResponse = {
  threads: [ROW],
  unread: 1,
  user: "me@example.com",
};

const THREAD: ThreadResponse = {
  thread_id: "t1",
  messages: [
    {
      id: "m1",
      thread_id: "t1",
      direction: "in",
      folder: "inbox",
      msg_from: "Alice <alice@example.com>",
      msg_to: "me@example.com",
      subject: "Hello from Alice",
      snippet: "just checking in",
      date: Date.now(),
      unread: 1,
      has_attachments: 0,
      msg_cc: null,
      message_id: "<mid>",
      in_reply_to: null,
      body: { text: "just checking in", html: "", attachments: [] },
    },
  ],
};

function renderApp() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
}

function key(k: string, opts: KeyboardEventInit = {}) {
  fireEvent.keyDown(document, { key: k, ...opts });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listThreads).mockResolvedValue(THREADS_RESP);
  vi.mocked(getCounts).mockResolvedValue({ inbox: 1, starred: 0, sent: 0, all: 1, trash: 0, inboxUnread: 1 });
  vi.mocked(getThread).mockResolvedValue(THREAD);
  vi.mocked(getMe).mockResolvedValue({ email: "me@example.com" } as Me);
  localStorage.clear();
  document.documentElement.classList.remove("dark");
});

describe("shortcut: c → compose dialog opens", () => {
  it("pressing c opens the compose dialog", async () => {
    renderApp();
    // Threads must be loaded so the app isn't still showing a skeleton
    await screen.findByText("Hello from Alice");
    key("c");
    await waitFor(() =>
      expect(screen.getByRole("dialog")).toBeInTheDocument(),
    );
  });
});

describe("shortcut: ? → help dialog opens", () => {
  it("pressing ? opens the shortcut help dialog", async () => {
    renderApp();
    await screen.findByText("Hello from Alice");
    key("?");
    await waitFor(() =>
      expect(screen.getByText("Keyboard shortcuts")).toBeInTheDocument(),
    );
  });
});

describe("shortcut: e → archive the selected thread", () => {
  it("pressing e after selecting a thread calls archive mutate", async () => {
    renderApp();
    // Select the thread via j first
    await screen.findByText("Hello from Alice");
    key("j");
    // Wait for the thread to be selected (reader heading appears)
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Hello from Alice" }),
      ).toBeInTheDocument(),
    );
    key("e");
    await waitFor(() =>
      expect(vi.mocked(mutateThread)).toHaveBeenCalledWith("t1", "archive"),
    );
  });
});

describe("shortcut: g t → view switches to Trash", () => {
  it("pressing g then t switches the view to Trash", async () => {
    renderApp();
    await screen.findByText("Hello from Alice");
    // g + t sequence
    key("g");
    key("t");
    // After view switch, listThreads should be called with view: "trash"
    await waitFor(() =>
      expect(vi.mocked(listThreads)).toHaveBeenCalledWith(
        expect.objectContaining({ view: "trash" }),
      ),
    );
  });
});

describe("shortcut: Keyboard shortcuts command palette item", () => {
  it("shows 'Keyboard shortcuts' item in the command palette", async () => {
    renderApp();
    fireEvent.click(
      screen.getByRole("button", { name: /open command palette/i }),
    );
    await waitFor(() =>
      expect(screen.getByText("Keyboard shortcuts")).toBeInTheDocument(),
    );
  });
});

describe("shortcut: j/k navigation (via hook — existing behaviour)", () => {
  it("j selects the first thread and shows it in the reader", async () => {
    renderApp();
    await screen.findByText("Hello from Alice");
    key("j");
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Hello from Alice" }),
      ).toBeInTheDocument(),
    );
  });
});
