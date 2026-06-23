/**
 * Tests for per-row actions, interactive star, and undo toasts in MessageList.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import MessageList from "../components/MessageList";
import type { ThreadsResponse, ThreadListRow } from "../lib/types";

// --- Mocks ---

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
  attachmentUrl: vi.fn(),
  ApiError: class ApiError extends Error { status = 0; },
}));

vi.mock("sonner", () => ({
  toast: vi.fn(),
}));

import { listThreads, mutateThread, mutateThreads } from "../lib/api";
import { toast } from "sonner";

// --- Fixtures ---

const THREAD_INBOX: ThreadListRow = {
  thread_id: "t-inbox",
  id: "m1",
  msg_from: "Alice <alice@example.com>",
  msg_to: "me@example.com",
  subject: "Inbox thread",
  snippet: "hi",
  date: Date.now(),
  count: 1,
  anyUnread: 1,
  hasAttachments: 0,
  starred: 0,
  category: null,
};

const THREAD_STARRED: ThreadListRow = {
  ...THREAD_INBOX,
  thread_id: "t-starred",
  subject: "Starred thread",
  starred: 1,
  category: null,
};

const THREAD_TRASH: ThreadListRow = {
  ...THREAD_INBOX,
  thread_id: "t-trash",
  subject: "Trash thread",
};

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

function renderList(
  threads: ThreadListRow[],
  view: "inbox" | "trash" = "inbox",
  opts?: { selectedIds?: Set<string> },
) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  vi.mocked(listThreads).mockResolvedValue({
    threads,
    unread: 0,
    user: "me@example.com",
  } as ThreadsResponse);

  return render(
    <QueryClientProvider client={qc}>
      <MessageList
        view={view}
        selectedThreadId={null}
        onSelect={vi.fn()}
        selectedIds={opts?.selectedIds ?? new Set()}
        onToggleSelect={vi.fn()}
        onSelectRange={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------

describe("MessageList row actions — inbox view", () => {
  it("calls mutateThread with archive and shows undo toast", async () => {
    renderList([THREAD_INBOX]);

    const archiveBtn = await screen.findByRole("button", { name: "Archive" });
    fireEvent.click(archiveBtn);

    await waitFor(() => {
      expect(mutateThread).toHaveBeenCalledWith("t-inbox", "archive");
    });
    expect(toast).toHaveBeenCalledWith(
      "Archived",
      expect.objectContaining({ action: expect.objectContaining({ label: "Undo" }) }),
    );
  });

  it("calls mutateThread with trash and shows undo toast", async () => {
    renderList([THREAD_INBOX]);

    const trashBtn = await screen.findByRole("button", { name: "Move to trash" });
    fireEvent.click(trashBtn);

    await waitFor(() => {
      expect(mutateThread).toHaveBeenCalledWith("t-inbox", "trash");
    });
    expect(toast).toHaveBeenCalledWith(
      "Moved to Trash",
      expect.objectContaining({ action: expect.objectContaining({ label: "Undo" }) }),
    );
  });

  it("star button sends 'star' action for an unstarred thread", async () => {
    renderList([THREAD_INBOX]);

    const starBtn = await screen.findByRole("button", { name: "Star" });
    fireEvent.click(starBtn);

    await waitFor(() => {
      expect(mutateThread).toHaveBeenCalledWith("t-inbox", "star");
    });
    expect(toast).toHaveBeenCalledWith(
      "Starred",
      expect.objectContaining({ action: expect.objectContaining({ label: "Undo" }) }),
    );
  });

  it("star button sends 'unstar' action for an already-starred thread", async () => {
    renderList([THREAD_STARRED], "inbox");

    const unstarBtn = await screen.findByRole("button", { name: "Unstar" });
    fireEvent.click(unstarBtn);

    await waitFor(() => {
      expect(mutateThread).toHaveBeenCalledWith("t-starred", "unstar");
    });
  });

  it("Archive/Trash buttons appear in inbox view (not Restore/Delete)", async () => {
    renderList([THREAD_INBOX]);
    expect(await screen.findByRole("button", { name: "Archive" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Move to trash" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restore" })).not.toBeInTheDocument();
  });
});

describe("MessageList row actions — trash view", () => {
  it("shows Restore and Delete forever buttons (not Archive/Move to trash)", async () => {
    renderList([THREAD_TRASH], "trash");
    expect(await screen.findByRole("button", { name: "Restore" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete forever" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
  });

  it("Restore calls mutateThread with restore", async () => {
    renderList([THREAD_TRASH], "trash");

    const restoreBtn = await screen.findByRole("button", { name: "Restore" });
    fireEvent.click(restoreBtn);

    await waitFor(() => {
      expect(mutateThread).toHaveBeenCalledWith("t-trash", "restore");
    });
  });

  it("Delete forever opens confirm dialog", async () => {
    renderList([THREAD_TRASH], "trash");

    const deleteBtn = await screen.findByRole("button", { name: "Delete forever" });
    fireEvent.click(deleteBtn);

    // AlertDialog should appear
    await waitFor(() => {
      expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    });
    expect(screen.getByText("Delete forever?")).toBeInTheDocument();
  });
});

describe("MessageList — action buttons stop propagation", () => {
  it("clicking Archive does NOT call onSelect", async () => {
    const onSelect = vi.fn();
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    vi.mocked(listThreads).mockResolvedValue({
      threads: [THREAD_INBOX],
      unread: 0,
      user: "me@example.com",
    } as ThreadsResponse);

    render(
      <QueryClientProvider client={qc}>
        <MessageList
          view="inbox"
          selectedThreadId={null}
          onSelect={onSelect}
          selectedIds={new Set()}
          onToggleSelect={vi.fn()}
          onSelectRange={vi.fn()}
        />
      </QueryClientProvider>,
    );

    const archiveBtn = await screen.findByRole("button", { name: "Archive" });
    fireEvent.click(archiveBtn);

    expect(onSelect).not.toHaveBeenCalled();
  });
});
