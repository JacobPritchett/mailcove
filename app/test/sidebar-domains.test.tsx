import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "../App";
import type { ThreadsResponse, ThreadListRow, Me, ViewCounts } from "../lib/types";

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
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() }, Toaster: () => null }));

import { listThreads, getCounts, getMe } from "../lib/api";

const row = (overrides: Partial<ThreadListRow>): ThreadListRow => ({
  thread_id: "t1",
  id: "m1",
  msg_from: "Alice <alice@example.com>",
  msg_to: "hello@example.com",
  subject: "Hello",
  snippet: "hi",
  date: Date.UTC(2026, 5, 8),
  count: 1,
  anyUnread: 0,
  hasAttachments: 0,
  starred: 0,
  category: null,
  domain: "example.com",
  ...overrides,
});

const MULTI_COUNTS: ViewCounts = {
  inbox: 3,
  starred: 0,
  sent: 0,
  all: 3,
  trash: 0,
  inboxUnread: 1,
  domains: [
    { domain: "example.org", threads: 1, unread: 1 },
    { domain: "example.com", threads: 2, unread: 0 },
  ],
};

function renderApp() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listThreads).mockResolvedValue({
    threads: [row({}), row({ thread_id: "t2", id: "m2", domain: "example.org", subject: "Org mail" })],
    unread: 1,
    user: "x",
  } as ThreadsResponse);
  vi.mocked(getCounts).mockResolvedValue(MULTI_COUNTS);
  vi.mocked(getMe).mockResolvedValue({ email: "alex@example.com" } as Me);
});

describe("Sidebar inbox switcher (multi-domain)", () => {
  it("lists each domain with its unread badge once more than one domain exists", async () => {
    renderApp();
    expect(await screen.findByText("Inboxes")).toBeInTheDocument();
    // Scope to the desktop sidebar — thread rows can also carry domain text.
    const aside = within(screen.getByRole("complementary"));
    expect(aside.getByRole("button", { name: /All inboxes/ })).toBeInTheDocument();
    expect(aside.getByRole("button", { name: /example\.org/ })).toBeInTheDocument();
    expect(aside.getByRole("button", { name: /example\.com/ })).toBeInTheDocument();
  });

  it("clicking a domain refetches the list scoped to that domain", async () => {
    renderApp();
    await screen.findByText("Inboxes");
    const aside = within(screen.getByRole("complementary"));
    fireEvent.click(aside.getByRole("button", { name: /example\.org/ }));
    await waitFor(() =>
      expect(listThreads).toHaveBeenCalledWith(expect.objectContaining({ domain: "example.org" })),
    );
  });

  it("hides the switcher for a single-domain inbox", async () => {
    vi.mocked(getCounts).mockResolvedValue({
      ...MULTI_COUNTS,
      domains: [{ domain: "example.com", threads: 3, unread: 1 }],
    });
    renderApp();
    await screen.findByText("Hello");
    expect(screen.queryByText("Inboxes")).not.toBeInTheDocument();
  });

  it("shows per-row domain chips while viewing all inboxes", async () => {
    renderApp();
    // Two rows, two different domain chips (the chip text equals the domain).
    expect(await screen.findByText("Org mail")).toBeInTheDocument();
    const chips = screen.getAllByText(/example\.org|example\.com/);
    // At least one chip per row beyond the sidebar buttons.
    expect(chips.length).toBeGreaterThanOrEqual(4);
  });
});
