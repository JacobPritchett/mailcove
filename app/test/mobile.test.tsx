import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
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

/** Force `useIsDesktop()` to report mobile (min-width:768px → not matching). */
function setViewport(isDesktop: boolean) {
  window.matchMedia = ((query: string) =>
    ({
      matches: /min-width:\s*768px/.test(query) ? isDesktop : !isDesktop,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listThreads).mockResolvedValue(THREADS_RESP);
  vi.mocked(getCounts).mockResolvedValue({ inbox: 1, starred: 0, sent: 0, all: 1, trash: 0, inboxUnread: 1 });
  vi.mocked(getThread).mockResolvedValue(THREAD);
  vi.mocked(getMe).mockResolvedValue({ email: "me@example.com" } as Me);
  setViewport(false); // mobile
});

afterEach(() => {
  setViewport(true); // restore desktop default for other suites
});

describe("mobile layout", () => {
  it("renders the drawer (hamburger) toggle on mobile", () => {
    renderApp();
    expect(
      screen.getByRole("button", { name: /open menu/i }),
    ).toBeInTheDocument();
  });

  it("opens the view drawer with Inbox/Sent when the hamburger is tapped", async () => {
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: /open menu/i }));
    // Drawer (Sheet) mounts its own view nav; both desktop aside + drawer now
    // expose Inbox/Sent, so there are 2 of each once the drawer is open.
    await waitFor(() =>
      expect(screen.getAllByText("Inbox").length).toBeGreaterThan(1),
    );
    expect(screen.getAllByText("Sent").length).toBeGreaterThan(1);
  });

  it("navigates list → full-screen reader and back via the back arrow", async () => {
    renderApp();
    fireEvent.click(await screen.findByText("Hello from Alice"));

    // Reader opens with a Back control.
    const back = await screen.findByRole("button", { name: /back to list/i });
    expect(back).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Hello from Alice" }),
      ).toBeInTheDocument(),
    );

    // Back returns to the list.
    fireEvent.click(back);
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /back to list/i }),
      ).not.toBeInTheDocument(),
    );
  });

  it("hardware Back (popstate) returns from the reader to the list", async () => {
    renderApp();
    fireEvent.click(await screen.findByText("Hello from Alice"));

    // Reader opens.
    await screen.findByRole("button", { name: /back to list/i });

    // Simulate the hardware/browser Back button firing a popstate event.
    fireEvent.popState(window);

    // We land back on the list (the Back control is gone), not out of the app.
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /back to list/i }),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: /open menu/i }),
    ).toBeInTheDocument();
  });

  it("focuses the search input after opening mobile search via ⌘K", async () => {
    vi.useFakeTimers();
    try {
      renderApp();
      // The mobile app bar's search input isn't rendered until search opens.
      expect(
        screen.queryByLabelText("Search messages input"),
      ).not.toBeInTheDocument();

      // Open mobile search the same way the ⌘K "Focus search" action does.
      fireEvent.click(screen.getByRole("button", { name: /search messages/i }));

      // Flush the requestAnimationFrame the focus effect schedules.
      await vi.runOnlyPendingTimersAsync();

      const input = screen.getByLabelText(
        "Search messages input",
      ) as HTMLInputElement;
      expect(document.activeElement).toBe(input);
    } finally {
      vi.useRealTimers();
    }
  });
});
