/**
 * Tests for useMutateThreads: optimistic remove/update + rollback on error.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useMutateThreads } from "@/lib/queries";
import type { ThreadsResponse, ThreadListRow } from "@/lib/types";

// Mock the api module so we control success/failure.
vi.mock("@/lib/api", () => ({
  mutateThread: vi.fn(),
  mutateThreads: vi.fn(),
  listThreads: vi.fn(),
  getCounts: vi.fn(),
  getMessage: vi.fn(),
  getMe: vi.fn(),
  send: vi.fn(),
  getThread: vi.fn(),
  attachmentUrl: vi.fn(),
  ApiError: class ApiError extends Error { status = 0; },
}));

import { mutateThread as apiMutateThread } from "@/lib/api";

const THREAD_A: ThreadListRow = {
  thread_id: "ta",
  id: "ma",
  msg_from: "alice@example.com",
  msg_to: "me@test.com",
  subject: "Thread A",
  snippet: "hello",
  date: 1000,
  count: 1,
  anyUnread: 1,
  hasAttachments: 0,
  starred: 0,
  category: null,
};

const THREAD_B: ThreadListRow = {
  thread_id: "tb",
  id: "mb",
  msg_from: "bob@example.com",
  msg_to: "me@test.com",
  subject: "Thread B",
  snippet: "world",
  date: 2000,
  count: 2,
  anyUnread: 0,
  hasAttachments: 0,
  starred: 0,
  category: null,
};

const INITIAL_DATA: ThreadsResponse = {
  threads: [THREAD_A, THREAD_B],
  unread: 1,
  user: "me@test.com",
};

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: qc }, children);
  };
}

function makeQc() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useMutateThreads optimistic update", () => {
  it("optimistically removes an archived thread from the inbox view", async () => {
    const qc = makeQc();
    qc.setQueryData(["threads", "inbox", "", "", ""], INITIAL_DATA);

    vi.mocked(apiMutateThread).mockResolvedValue({ ok: true });

    const { result } = renderHook(() => useMutateThreads("inbox"), {
      wrapper: makeWrapper(qc),
    });

    act(() => {
      result.current.mutate({ threadIds: ["ta"], action: "archive" });
    });

    // Optimistically removed before the server responds.
    await waitFor(() => {
      const data = qc.getQueryData<ThreadsResponse>(["threads", "inbox", "", "", ""]);
      expect(data?.threads.map((t) => t.thread_id)).not.toContain("ta");
      expect(data?.threads.map((t) => t.thread_id)).toContain("tb");
    });
  });

  it("rolls back the optimistic update on server error", async () => {
    const qc = makeQc();
    qc.setQueryData(["threads", "inbox", "", "", ""], INITIAL_DATA);

    vi.mocked(apiMutateThread).mockRejectedValue(new Error("server error"));

    const { result } = renderHook(() => useMutateThreads("inbox"), {
      wrapper: makeWrapper(qc),
    });

    act(() => {
      result.current.mutate({ threadIds: ["ta"], action: "archive" });
    });

    // After error the rollback restores both threads.
    await waitFor(() => {
      const data = qc.getQueryData<ThreadsResponse>(["threads", "inbox", "", "", ""]);
      expect(data?.threads.map((t) => t.thread_id)).toContain("ta");
      expect(data?.threads.map((t) => t.thread_id)).toContain("tb");
    });
  });
});
