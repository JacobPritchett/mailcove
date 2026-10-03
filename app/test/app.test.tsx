import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
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
      body: { text: "just checking in\nbody text", html: "", attachments: [] },
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
});

describe("<App/> mail layout", () => {
  it("renders the Inbox and Sent nav items", () => {
    renderApp();
    expect(screen.getByText("Inbox")).toBeInTheDocument();
    expect(screen.getByText("Sent")).toBeInTheDocument();
  });

  it("puts the inbox's unread count in the tab title", async () => {
    document.title = "Mailcove";
    const { unmount } = renderApp();
    await waitFor(() => expect(document.title).toBe("(1) Inbox"));
    unmount();
    expect(document.title).toBe("Mailcove");
  });

  it("shows a message row from the mocked list", async () => {
    renderApp();
    expect(await screen.findByText("Hello from Alice")).toBeInTheDocument();
  });

  it("keeps the real sender address on screen when the display name fakes one", async () => {
    // postal-mime hands back the display name verbatim and the server
    // re-serializes it as `${name} <${address}>`, so
    //   From: "Legit Corp <billing@legit.com>" <evil@attacker.example>
    // yields a NAME that already contains a plausible address. Showing the name
    // alone would render this byte-identically to real mail from Legit Corp.
    vi.mocked(getThread).mockResolvedValue({
      ...THREAD,
      messages: [
        {
          ...THREAD.messages[0],
          msg_from: "Legit Corp <billing@legit.com> <evil@attacker.example>",
          from_addr: "evil@attacker.example",
        },
      ],
    });

    renderApp();
    fireEvent.click(await screen.findByText("Hello from Alice"));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Hello from Alice" })).toBeInTheDocument(),
    );

    const reader = within(screen.getByRole("main"));
    expect(reader.getByText("evil@attacker.example")).toBeInTheDocument();
  });

  it("opens the reading pane header when a row is selected", async () => {
    renderApp();
    const row = await screen.findByText("Hello from Alice");
    fireEvent.click(row);

    // Reader header renders subject (h1) + From metadata.
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Hello from Alice" }),
      ).toBeInTheDocument(),
    );
    // The header shows the sender's NAME; the raw "Name <addr>" form is detail
    // behind the disclosure, not the everyday reading need. Scoped to the
    // reading pane because the list row renders the same name.
    const reader = within(screen.getByRole("main"));
    expect(reader.getByText("Alice")).toBeInTheDocument();
    expect(reader.queryByText("Alice <alice@example.com>")).not.toBeInTheDocument();

    // ...and the full addresses are still one click away, so nothing that was
    // readable before became unreachable.
    fireEvent.click(reader.getByRole("button", { expanded: false, name: /^to / }));
    expect(await reader.findByText("Alice <alice@example.com>")).toBeInTheDocument();

    expect(getThread).toHaveBeenCalledWith("t1");
  });
});

describe("<App/> conversation threading", () => {
  const REPLY_ROW: ThreadListRow = {
    thread_id: "t1",
    id: "m2",
    msg_from: "Alice <alice@example.com>",
    msg_to: "me@example.com",
    subject: "Re: Hello from Alice",
    snippet: "thanks Alice",
    date: ROW.date + 1000,
    count: 2,
    anyUnread: 1,
    hasAttachments: 0,
    starred: 0,
    category: null,
  };

  beforeEach(() => {
    // Server already collapses threads; return a single row with count=2.
    vi.mocked(listThreads).mockResolvedValue({
      threads: [REPLY_ROW],
      unread: 1,
      user: "me@example.com",
    });
    vi.mocked(getThread).mockResolvedValue({
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
          date: ROW.date,
          unread: 1,
          has_attachments: 0,
          msg_cc: null,
          message_id: "<mid>",
          in_reply_to: null,
          body: { text: "first inbound body", html: "", attachments: [] },
        },
        {
          id: "m2",
          thread_id: "t1",
          direction: "out",
          folder: "sent",
          msg_from: "me@example.com",
          msg_to: "alice@example.com",
          subject: "Re: Hello from Alice",
          snippet: "thanks Alice",
          date: ROW.date + 1000,
          unread: 0,
          has_attachments: 0,
          msg_cc: null,
          message_id: "<mid-2>",
          in_reply_to: "<mid>",
          body: { text: "second sent body", html: "", attachments: [] },
        },
      ],
    });
  });

  it("shows a single collapsed row with a count badge for a multi-message thread", async () => {
    renderApp();
    // Only ONE list row (the server-collapsed latest subject).
    const rows = await screen.findAllByText(/Hello from Alice|Re: Hello from Alice/);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("Re: Hello from Alice");
    // Count badge for the 2-message thread.
    expect(screen.getByLabelText("2 messages")).toBeInTheDocument();
  });

  it("shows every message body when the conversation is opened", async () => {
    renderApp();
    fireEvent.click(await screen.findByText("Re: Hello from Alice"));

    await waitFor(() =>
      expect(screen.getByText("first inbound body")).toBeInTheDocument(),
    );
    expect(screen.getByText("second sent body")).toBeInTheDocument();
    expect(getThread).toHaveBeenCalledWith("t1");
  });
});
