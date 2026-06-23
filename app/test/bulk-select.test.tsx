/**
 * Tests for multi-select + BulkActionBar.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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

vi.mock("sonner", () => ({
  toast: vi.fn(),
  Toaster: () => null,
}));

import { listThreads, getCounts, getThread, getMe, mutateThreads } from "../lib/api";
import { toast } from "sonner";

const THREAD_A: ThreadListRow = {
  thread_id: "ta",
  id: "ma",
  msg_from: "Alice <alice@example.com>",
  msg_to: "me@example.com",
  subject: "Thread A",
  snippet: "hello A",
  date: Date.now() - 2000,
  count: 1,
  anyUnread: 1,
  hasAttachments: 0,
  starred: 0,
  category: null,
};

const THREAD_B: ThreadListRow = {
  thread_id: "tb",
  id: "mb",
  msg_from: "Bob <bob@example.com>",
  msg_to: "me@example.com",
  subject: "Thread B",
  snippet: "hello B",
  date: Date.now() - 1000,
  count: 1,
  anyUnread: 0,
  hasAttachments: 0,
  starred: 0,
  category: null,
};

const THREAD_C: ThreadListRow = {
  thread_id: "tc",
  id: "mc",
  msg_from: "Carol <carol@example.com>",
  msg_to: "me@example.com",
  subject: "Thread C",
  snippet: "hello C",
  date: Date.now() - 500,
  count: 1,
  anyUnread: 0,
  hasAttachments: 0,
  starred: 0,
  category: null,
};

const THREADS_RESP: ThreadsResponse = {
  threads: [THREAD_A, THREAD_B, THREAD_C],
  unread: 1,
  user: "me@example.com",
};

const STUB_THREAD: ThreadResponse = {
  thread_id: "ta",
  messages: [
    {
      id: "ma",
      thread_id: "ta",
      direction: "in",
      folder: "inbox",
      msg_from: "Alice <alice@example.com>",
      msg_to: "me@example.com",
      subject: "Thread A",
      snippet: "hello A",
      date: Date.now(),
      unread: 0,
      has_attachments: 0,
      body: { text: "body", html: "", attachments: [] },
    },
  ],
};

function renderApp() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listThreads).mockResolvedValue(THREADS_RESP);
  vi.mocked(getCounts).mockResolvedValue({
    inbox: 2, starred: 0, sent: 0, all: 2, trash: 0, inboxUnread: 1,
  });
  vi.mocked(getThread).mockResolvedValue(STUB_THREAD);
  vi.mocked(getMe).mockResolvedValue({ email: "me@example.com" } as Me);
});

describe("Bulk selection and BulkActionBar", () => {
  it("shows bulk bar with '2 selected' after selecting two rows", async () => {
    renderApp();

    // Wait for rows
    const checkboxA = await screen.findByRole("checkbox", { name: /Select thread: Thread A/i });
    const checkboxB = screen.getByRole("checkbox", { name: /Select thread: Thread B/i });

    fireEvent.click(checkboxA);
    fireEvent.click(checkboxB);

    await waitFor(() => {
      expect(screen.getByText("2 selected")).toBeInTheDocument();
    });
  });

  it("Trash bulk action calls mutateThreads with both ids + 'trash'", async () => {
    renderApp();

    const checkboxA = await screen.findByRole("checkbox", { name: /Select thread: Thread A/i });
    const checkboxB = screen.getByRole("checkbox", { name: /Select thread: Thread B/i });

    fireEvent.click(checkboxA);
    fireEvent.click(checkboxB);

    await waitFor(() => screen.getByText("2 selected"));

    const trashBtn = screen.getByRole("button", { name: "Move selected to trash" });
    fireEvent.click(trashBtn);

    await waitFor(() => {
      expect(mutateThreads).toHaveBeenCalledWith(
        expect.arrayContaining(["ta", "tb"]),
        "trash",
      );
    });
  });

  it("clears selection after bulk action", async () => {
    renderApp();

    const checkboxA = await screen.findByRole("checkbox", { name: /Select thread: Thread A/i });
    fireEvent.click(checkboxA);

    await waitFor(() => screen.getByText("1 selected"));

    const archiveBtn = screen.getByRole("button", { name: "Archive selected" });
    fireEvent.click(archiveBtn);

    await waitFor(() => {
      expect(screen.queryByText("1 selected")).not.toBeInTheDocument();
    });
  });

  it("Clear button clears selection without performing any action", async () => {
    renderApp();

    const checkboxA = await screen.findByRole("checkbox", { name: /Select thread: Thread A/i });
    fireEvent.click(checkboxA);

    await waitFor(() => screen.getByText("1 selected"));

    const clearBtn = screen.getByRole("button", { name: "Clear selection" });
    fireEvent.click(clearBtn);

    await waitFor(() => {
      expect(screen.queryByText("1 selected")).not.toBeInTheDocument();
    });
    expect(mutateThreads).not.toHaveBeenCalled();
  });

  it("shows undo toast for reversible bulk actions", async () => {
    renderApp();

    const checkboxA = await screen.findByRole("checkbox", { name: /Select thread: Thread A/i });
    fireEvent.click(checkboxA);

    await waitFor(() => screen.getByText("1 selected"));

    const archiveBtn = screen.getByRole("button", { name: "Archive selected" });
    fireEvent.click(archiveBtn);

    await waitFor(() => {
      expect(toast).toHaveBeenCalledWith(
        expect.stringContaining("archived"),
        expect.objectContaining({ action: expect.objectContaining({ label: "Undo" }) }),
      );
    });
  });

  it("shift-click selects a contiguous range (rows 1–3)", async () => {
    renderApp();

    // Click the first checkbox (sets anchor = "ta")
    const checkboxA = await screen.findByRole("checkbox", { name: /Select thread: Thread A/i });
    fireEvent.click(checkboxA);

    await waitFor(() => screen.getByText("1 selected"));

    // Shift-click the third checkbox — should range-select ta, tb, tc
    const checkboxC = screen.getByRole("checkbox", { name: /Select thread: Thread C/i });
    fireEvent.click(checkboxC, { shiftKey: true });

    await waitFor(() => {
      expect(screen.getByText("3 selected")).toBeInTheDocument();
    });
  });
});
