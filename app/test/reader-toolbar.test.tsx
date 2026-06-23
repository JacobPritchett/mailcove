/**
 * Tests for Reader conversation toolbar (D4).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Reader from "../components/Reader";
import type { ThreadResponse } from "../lib/types";

// Mock the api module (Reader calls mutateThread internally for auto-read marking)
vi.mock("../lib/api", () => ({
  listThreads: vi.fn(),
  getCounts: vi.fn(),
  mutateThread: vi.fn(() => Promise.resolve({ ok: true })),
  mutateThreads: vi.fn(() => Promise.resolve({ ok: true, count: 0 })),
  getMessage: vi.fn(),
  getMe: vi.fn(),
  getIdentities: vi.fn(() => Promise.resolve({ identities: [], defaultLocal: "hello", defaultDomain: "example.com" })),
  send: vi.fn(),
  getThread: vi.fn(),
  attachmentUrl: vi.fn((id, name) => `/api/attachments/${id}/${name}`),
  ApiError: class ApiError extends Error { status = 0; },
}));

import { getThread } from "../lib/api";

const INBOX_THREAD: ThreadResponse = {
  thread_id: "t1",
  messages: [
    {
      id: "m1",
      thread_id: "t1",
      direction: "in",
      folder: "inbox",
      msg_from: "Alice <alice@example.com>",
      msg_to: "me@example.com",
      subject: "Test subject",
      snippet: "hi",
      date: Date.now(),
      unread: 0,
      has_attachments: 0,
      starred: 0,
      body: { text: "body text", html: "", attachments: [] },
    },
  ],
};

const STARRED_THREAD: ThreadResponse = {
  ...INBOX_THREAD,
  messages: [{ ...INBOX_THREAD.messages[0], starred: 1 }],
};

const TRASH_THREAD: ThreadResponse = {
  ...INBOX_THREAD,
  messages: [{ ...INBOX_THREAD.messages[0], folder: "trash" }],
};

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

function renderReader(
  thread: ThreadResponse,
  view: "inbox" | "trash" | "starred" = "inbox",
  onAction = vi.fn(),
) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  vi.mocked(getThread).mockResolvedValue(thread);

  return {
    onAction,
    ...render(
      <QueryClientProvider client={qc}>
        <Reader
          threadId={thread.thread_id}
          view={view}
          onAction={onAction}
        />
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Reader toolbar — inbox view", () => {
  it("Archive button calls onAction('archive')", async () => {
    const { onAction } = renderReader(INBOX_THREAD);

    const btn = await screen.findByRole("button", { name: "Archive" });
    fireEvent.click(btn);

    expect(onAction).toHaveBeenCalledWith("archive");
  });

  it("Move to trash button calls onAction('trash')", async () => {
    const { onAction } = renderReader(INBOX_THREAD);

    const btn = await screen.findByRole("button", { name: "Move to trash" });
    fireEvent.click(btn);

    expect(onAction).toHaveBeenCalledWith("trash");
  });

  it("Star button calls onAction('star') for unstarred thread", async () => {
    const { onAction } = renderReader(INBOX_THREAD);

    const btn = await screen.findByRole("button", { name: "Star" });
    fireEvent.click(btn);

    expect(onAction).toHaveBeenCalledWith("star");
  });

  it("Star button calls onAction('unstar') for starred thread", async () => {
    const { onAction } = renderReader(STARRED_THREAD);

    const btn = await screen.findByRole("button", { name: "Unstar" });
    fireEvent.click(btn);

    expect(onAction).toHaveBeenCalledWith("unstar");
  });

  it("Unread button calls onAction('unread')", async () => {
    const { onAction } = renderReader(INBOX_THREAD);

    const btn = await screen.findByRole("button", { name: "Mark as unread" });
    fireEvent.click(btn);

    expect(onAction).toHaveBeenCalledWith("unread");
  });

  it("shows Archive and Trash buttons (not Restore/Delete forever)", async () => {
    renderReader(INBOX_THREAD);

    expect(await screen.findByRole("button", { name: "Archive" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Move to trash" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restore" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete forever" })).not.toBeInTheDocument();
  });
});

describe("Reader toolbar — trash view", () => {
  it("shows Restore and Delete forever buttons (not Archive/Trash)", async () => {
    renderReader(TRASH_THREAD, "trash");

    expect(await screen.findByRole("button", { name: "Restore" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete forever" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move to trash" })).not.toBeInTheDocument();
  });

  it("Restore button calls onAction('restore')", async () => {
    const { onAction } = renderReader(TRASH_THREAD, "trash");

    const btn = await screen.findByRole("button", { name: "Restore" });
    fireEvent.click(btn);

    expect(onAction).toHaveBeenCalledWith("restore");
  });

  it("Delete forever opens AlertDialog", async () => {
    renderReader(TRASH_THREAD, "trash");

    const deleteBtn = await screen.findByRole("button", { name: "Delete forever" });
    fireEvent.click(deleteBtn);

    await waitFor(() => {
      expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    });
    expect(screen.getByText("Delete forever?")).toBeInTheDocument();
  });
});
