import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "../App";
import type { ThreadsResponse, ThreadListRow, ThreadResponse, Me } from "../lib/types";

// Mock the typed api client so the app renders against deterministic data.
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

import { listThreads, getCounts, getThread, getMe } from "../lib/api";

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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listThreads).mockResolvedValue(THREADS_RESP);
  vi.mocked(getCounts).mockResolvedValue({ inbox: 1, starred: 0, sent: 0, all: 1, trash: 0, inboxUnread: 1 });
  vi.mocked(getThread).mockResolvedValue(THREAD);
  vi.mocked(getMe).mockResolvedValue({ email: "me@example.com" } as Me);
  // Reset any persisted/applied theme between tests.
  localStorage.clear();
  document.documentElement.classList.remove("dark");
});

afterEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove("dark");
});

describe("command palette", () => {
  it("opens from the top-bar affordance and lists the command items", async () => {
    renderApp();
    fireEvent.click(
      screen.getByRole("button", { name: /open command palette/i }),
    );

    await waitFor(() =>
      expect(screen.getByText("Compose new message")).toBeInTheDocument(),
    );
    expect(screen.getByText("Go to Inbox")).toBeInTheDocument();
    expect(screen.getByText("Go to Sent")).toBeInTheDocument();
    expect(screen.getByText("Focus search")).toBeInTheDocument();
  });

  it("opens on Cmd+K", async () => {
    renderApp();
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    await waitFor(() =>
      expect(screen.getByText("Compose new message")).toBeInTheDocument(),
    );
  });

  it("'Go to Sent' switches the view query", async () => {
    renderApp();
    fireEvent.click(
      screen.getByRole("button", { name: /open command palette/i }),
    );
    fireEvent.click(await screen.findByText("Go to Sent"));

    await waitFor(() =>
      expect(listThreads).toHaveBeenCalledWith(
        expect.objectContaining({ view: "sent" }),
      ),
    );
  });
});

describe("keyboard nav", () => {
  it("j selects the first thread and opens it in the reader", async () => {
    renderApp();
    // Wait for the list to load before pressing j.
    await screen.findByText("Hello from Alice");
    fireEvent.keyDown(document, { key: "j" });

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Hello from Alice" }),
      ).toBeInTheDocument(),
    );
  });
});

describe("dark mode toggle", () => {
  it("flips the .dark class on <html> and persists the choice", async () => {
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    renderApp();

    const toggle = await screen.findByRole("button", {
      name: /switch to dark mode/i,
    });
    fireEvent.click(toggle);

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("mailcove-theme")).toBe("dark");

    // Toggling back returns to light.
    fireEvent.click(
      screen.getByRole("button", { name: /switch to light mode/i }),
    );
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem("mailcove-theme")).toBe("light");
  });
});
