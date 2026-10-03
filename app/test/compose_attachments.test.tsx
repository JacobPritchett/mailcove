// Staged attachments must not leak between compose sessions. The dialog stays
// mounted, so anything not reset in the [open] effect survives a close.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "../App";
import type { ThreadsResponse, Me } from "../lib/types";

vi.mock("../lib/api", () => ({
  ApiError: class ApiError extends Error {},
  listThreads: vi.fn(),
  getCounts: vi.fn(),
  mutateThread: vi.fn(() => Promise.resolve({ ok: true })),
  mutateThreads: vi.fn(() => Promise.resolve({ ok: true, count: 0 })),
  getThread: vi.fn(),
  getMe: vi.fn(),
  getIdentities: vi.fn(() =>
    Promise.resolve({ identities: [], defaultLocal: "hello", defaultDomain: "example.com" }),
  ),
  send: vi.fn(),
  getContacts: vi.fn(() => Promise.resolve({ contacts: [] })),
  putDraft: vi.fn(() => Promise.resolve({ ok: true })),
  getDraftAttachments: vi.fn(() => Promise.resolve({ attachments: [] })),
  putDraftAttachments: vi.fn(() => Promise.resolve({ ok: true })),
  deleteDraft: vi.fn(() => Promise.resolve({ ok: true })),
  listDrafts: vi.fn(() => Promise.resolve({ drafts: [] })),
  getDraft: vi.fn(),
  attachmentUrl: (id: string, name: string) => `/api/attachments/${id}/${name}`,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
  Toaster: () => null,
}));

import { listThreads, getCounts, getMe, send, putDraft, putDraftAttachments } from "../lib/api";

const THREADS_RESP: ThreadsResponse = { threads: [], unread: 0, user: "hello@example.com" };

function renderApp() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
}

function attach(name: string, body = "bytes") {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File([body], name, { type: "text/plain" });
  fireEvent.change(input, { target: { files: [file] } });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listThreads).mockResolvedValue(THREADS_RESP);
  vi.mocked(getCounts).mockResolvedValue({ inbox: 0, starred: 0, sent: 0, all: 0, trash: 0, inboxUnread: 0 });
  vi.mocked(getMe).mockResolvedValue({ email: "hello@example.com" } as Me);
  vi.mocked(send).mockResolvedValue({ ok: true, id: "sent-1" });
});

describe("compose attachments", () => {
  it("stages a picked file and shows it with a remove control", async () => {
    renderApp();
    fireEvent.click(screen.getAllByRole("button", { name: /compose/i })[0]);
    await screen.findByRole("dialog");

    attach("report.pdf");

    expect(await screen.findByText("report.pdf")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove report.pdf" })).toBeInTheDocument();
  });

  it("removes a staged file", async () => {
    renderApp();
    fireEvent.click(screen.getAllByRole("button", { name: /compose/i })[0]);
    await screen.findByRole("dialog");
    attach("report.pdf");
    await screen.findByText("report.pdf");

    fireEvent.click(screen.getByRole("button", { name: "Remove report.pdf" }));

    await waitFor(() => expect(screen.queryByText("report.pdf")).not.toBeInTheDocument());
  });

  it("does NOT carry a staged file into the next compose session", async () => {
    renderApp();

    // Session 1: attach, then close WITHOUT sending.
    fireEvent.click(screen.getAllByRole("button", { name: /compose/i })[0]);
    await screen.findByRole("dialog");
    attach("salary-review.pdf");
    await screen.findByText("salary-review.pdf");
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    // Session 2: a different message entirely.
    fireEvent.click(screen.getAllByRole("button", { name: /compose/i })[0]);
    await screen.findByRole("dialog");

    // If this fails, a file the user chose for one recipient is silently
    // attached to a message for another.
    expect(screen.queryByText("salary-review.pdf")).not.toBeInTheDocument();
  });

  it("does not carry a staged file across a send either", async () => {
    renderApp();
    fireEvent.click(screen.getAllByRole("button", { name: /compose/i })[0]);
    await screen.findByRole("dialog");
    attach("first.pdf");
    await screen.findByText("first.pdf");

    fireEvent.change(screen.getByLabelText("Add recipient"), {
      target: { value: "dest@example.com" },
    });
    fireEvent.keyDown(screen.getByLabelText("Add recipient"), { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));
    await waitFor(() => expect(send).toHaveBeenCalled());

    fireEvent.click(screen.getAllByRole("button", { name: /compose/i })[0]);
    await screen.findByRole("dialog");

    expect(screen.queryByText("first.pdf")).not.toBeInTheDocument();
  });
});

describe("attachments survive a saved draft", () => {
  it("saves a draft for a compose that holds only a file", async () => {
    // Before, a staged file was not "content", so closing saved no draft - and
    // with no draft row there was nowhere for the file to live.
    renderApp();
    fireEvent.click(screen.getAllByRole("button", { name: /compose/i })[0]);
    await screen.findByRole("dialog");
    attach("notes.txt");
    await screen.findByText("notes.txt");

    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);

    await waitFor(() => expect(putDraft).toHaveBeenCalled());
    await waitFor(() => expect(putDraftAttachments).toHaveBeenCalled());
    const [, sent] = vi.mocked(putDraftAttachments).mock.calls.at(-1)!;
    expect(sent).toHaveLength(1);
    expect(sent[0].name).toBe("notes.txt");
  });

  it("uploads the bytes to the same draft id as the row", async () => {
    // An orphaned blob is one whose id no row points at.
    renderApp();
    fireEvent.click(screen.getAllByRole("button", { name: /compose/i })[0]);
    await screen.findByRole("dialog");
    attach("notes.txt");
    await screen.findByText("notes.txt");

    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);

    await waitFor(() => expect(putDraftAttachments).toHaveBeenCalled());
    expect(vi.mocked(putDraftAttachments).mock.calls[0][0]).toBe(
      vi.mocked(putDraft).mock.calls[0][0],
    );
  });

  it("does not re-upload an unchanged set when only the body changes", async () => {
    // The body autosaves every 1.5s. Re-sending 10MB of base64 each time - for
    // a file the user has not touched - is the whole reason this is a separate
    // endpoint.
    renderApp();
    fireEvent.click(screen.getAllByRole("button", { name: /compose/i })[0]);
    await screen.findByRole("dialog");
    attach("notes.txt");
    await screen.findByText("notes.txt");
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "first" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    await waitFor(() => expect(putDraftAttachments).toHaveBeenCalledTimes(1));

    // Reopen, type more, close again: the row is written again, the bytes are not.
    fireEvent.click(screen.getAllByRole("button", { name: /compose/i })[0]);
    await screen.findByRole("dialog");
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "second" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);

    await waitFor(() => expect(vi.mocked(putDraft).mock.calls.length).toBeGreaterThan(1));
    expect(putDraftAttachments).toHaveBeenCalledTimes(1);
  });
});
