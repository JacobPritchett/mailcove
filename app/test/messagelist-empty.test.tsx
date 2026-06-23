/**
 * Tests for the empty-state CTAs in MessageList: Compose on an empty
 * Inbox/All Mail, Clear search when a search has no hits, and nothing when an
 * empty view has no sensible action (e.g. Trash).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import MessageList from "../components/MessageList";
import type { ThreadsResponse } from "../lib/types";

vi.mock("../lib/api", () => ({
  listThreads: vi.fn(),
  getCounts: vi.fn(),
  mutateThread: vi.fn(() => Promise.resolve({ ok: true })),
  mutateThreads: vi.fn(() => Promise.resolve({ ok: true, count: 0 })),
  getMessage: vi.fn(),
  getMe: vi.fn(),
  getIdentities: vi.fn(() =>
    Promise.resolve({ identities: [], defaultLocal: "hello", defaultDomain: "example.com" }),
  ),
  send: vi.fn(),
  getThread: vi.fn(),
  attachmentUrl: vi.fn(),
  ApiError: class ApiError extends Error { status = 0; },
}));

vi.mock("sonner", () => ({ toast: vi.fn() }));

import { listThreads } from "../lib/api";

function renderEmpty(props: Partial<React.ComponentProps<typeof MessageList>> & {
  view?: React.ComponentProps<typeof MessageList>["view"];
}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  vi.mocked(listThreads).mockResolvedValue({
    threads: [],
    unread: 0,
    user: "me@example.com",
  } as ThreadsResponse);

  return render(
    <QueryClientProvider client={qc}>
      <MessageList
        view={props.view ?? "inbox"}
        selectedThreadId={null}
        onSelect={vi.fn()}
        selectedIds={new Set()}
        onToggleSelect={vi.fn()}
        onSelectRange={vi.fn()}
        {...props}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("MessageList empty-state CTAs", () => {
  it("offers Compose on an empty inbox and fires onCompose", async () => {
    const onCompose = vi.fn();
    renderEmpty({ view: "inbox", onCompose });

    const cta = await screen.findByRole("button", { name: /compose message/i });
    fireEvent.click(cta);
    expect(onCompose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /clear search/i })).not.toBeInTheDocument();
  });

  it("offers Clear search (not Compose) when a search has no hits", async () => {
    const onCompose = vi.fn();
    const onClearSearch = vi.fn();
    renderEmpty({ view: "inbox", q: "nothing", onCompose, onClearSearch });

    const cta = await screen.findByRole("button", { name: /clear search/i });
    fireEvent.click(cta);
    expect(onClearSearch).toHaveBeenCalledTimes(1);
    expect(onCompose).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /compose message/i })).not.toBeInTheDocument();
  });

  it("shows no CTA on an empty Trash", async () => {
    renderEmpty({ view: "trash", onCompose: vi.fn(), onClearSearch: vi.fn() });

    expect(await screen.findByText(/no messages in trash/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /compose message/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /clear search/i })).not.toBeInTheDocument();
  });
});
