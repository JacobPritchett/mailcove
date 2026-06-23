/**
 * Tests for Reader Rich/Chat mode toggle (Task 2.2)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Reader from "@/components/Reader";
import type { ThreadResponse } from "@/lib/types";

vi.mock("@/lib/api", () => ({
  listThreads: vi.fn(),
  getCounts: vi.fn(),
  mutateThread: vi.fn(() => Promise.resolve({ ok: true })),
  mutateThreads: vi.fn(() => Promise.resolve({ ok: true, count: 0 })),
  getMessage: vi.fn(),
  getMe: vi.fn(),
  send: vi.fn(),
  getThread: vi.fn(),
  attachmentUrl: vi.fn((id: string, name: string) => `/api/attachments/${id}/${name}`),
  ApiError: class ApiError extends Error {
    status = 0;
  },
}));

import { getThread } from "@/lib/api";

const STUB: ThreadResponse = {
  thread_id: "t-mode",
  messages: [
    {
      id: "m-mode1",
      thread_id: "t-mode",
      direction: "in",
      folder: "inbox",
      msg_from: "Alice <a@x.com>",
      msg_to: "me@y.com",
      subject: "Mode test subject",
      snippet: "",
      date: 1_700_000_000_000,
      unread: 0,
      has_attachments: 0,
      starred: 0,
      body: { text: "hello mode switch", html: "", attachments: [] },
    } as any,
  ],
};

function renderReader(thread: ThreadResponse = STUB) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  vi.mocked(getThread).mockResolvedValue(thread);
  return render(
    <QueryClientProvider client={qc}>
      <Reader threadId={thread.thread_id} view="inbox" onAction={vi.fn()} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe("Reader Rich/Chat toggle", () => {
  it("has a Chat toggle control", async () => {
    renderReader();
    expect(await screen.findByRole("button", { name: /chat/i })).toBeInTheDocument();
  });

  it("has a Rich toggle control", async () => {
    renderReader();
    expect(await screen.findByRole("button", { name: /rich/i })).toBeInTheDocument();
  });

  it("defaults to rich mode — iframe or pre present, no chat bubble text in its place", async () => {
    renderReader();
    // Wait for the thread to load
    await screen.findByText(/hello mode switch/i);
    // In rich mode, body.html is empty so we get a <pre>; either pre or iframe means rich mode
    const pres = document.querySelectorAll("pre");
    const iframes = document.querySelectorAll("iframe");
    expect(pres.length + iframes.length).toBeGreaterThan(0);
  });

  it("clicking Chat switches to chat mode — pre/iframe gone, bubble text present", async () => {
    renderReader();
    // Wait for rich mode to render
    await screen.findByText(/hello mode switch/i);

    const chatBtn = screen.getByRole("button", { name: /chat/i });
    fireEvent.click(chatBtn);

    // After switching: the <pre>/<iframe> should be gone, text still present via SafeBlocks
    await waitFor(() => {
      const pres = document.querySelectorAll("pre");
      const iframes = document.querySelectorAll("iframe");
      expect(pres.length + iframes.length).toBe(0);
    });

    expect(screen.getByText(/hello mode switch/i)).toBeInTheDocument();
  });

  it("clicking Chat sets localStorage key reader.viewMode to 'chat'", async () => {
    renderReader();
    await screen.findByText(/hello mode switch/i);
    fireEvent.click(screen.getByRole("button", { name: /chat/i }));
    await waitFor(() => {
      expect(localStorage.getItem("reader.viewMode")).toBe("chat");
    });
  });

  it("clicking Rich after Chat restores iframe/pre", async () => {
    renderReader();
    await screen.findByText(/hello mode switch/i);

    // Switch to chat
    fireEvent.click(screen.getByRole("button", { name: /chat/i }));
    await waitFor(() => expect(localStorage.getItem("reader.viewMode")).toBe("chat"));

    // Switch back to rich
    fireEvent.click(screen.getByRole("button", { name: /rich/i }));
    await waitFor(() => {
      const pres = document.querySelectorAll("pre");
      const iframes = document.querySelectorAll("iframe");
      expect(pres.length + iframes.length).toBeGreaterThan(0);
    });
    expect(localStorage.getItem("reader.viewMode")).toBe("rich");
  });

  it("subject heading and toolbar are visible in both modes", async () => {
    renderReader();
    await screen.findByText(/Mode test subject/i);
    expect(screen.getByRole("heading", { name: /Mode test subject/i })).toBeInTheDocument();

    // Switch to chat
    fireEvent.click(screen.getByRole("button", { name: /chat/i }));
    await waitFor(() => expect(localStorage.getItem("reader.viewMode")).toBe("chat"));

    // Subject still visible
    expect(screen.getByRole("heading", { name: /Mode test subject/i })).toBeInTheDocument();
    // Archive toolbar still visible (onAction prop provided)
    expect(screen.getByRole("button", { name: "Archive" })).toBeInTheDocument();
  });
});
