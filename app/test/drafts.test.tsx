import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "../App";
import type { ThreadsResponse, Me, DraftFull } from "../lib/types";

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
  send: vi.fn(() => Promise.resolve({ ok: true, id: "sent-1" })),
  putDraft: vi.fn(() => Promise.resolve({ ok: true })),
  deleteDraft: vi.fn(() => Promise.resolve({ ok: true })),
  listDrafts: vi.fn(),
  getDraft: vi.fn(),
  attachmentUrl: (id: string, name: string) => `/api/attachments/${id}/${name}`,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() }, Toaster: () => null }));

import { listThreads, getCounts, getMe, send, putDraft, deleteDraft, listDrafts, getDraft } from "../lib/api";

const THREADS_RESP: ThreadsResponse = { threads: [], unread: 0, user: "hello@send.example.com" };

const DRAFT_ID = "11111111-2222-3333-4444-555555555555";
const FULL: DraftFull = {
  id: DRAFT_ID,
  threadId: null,
  inReplyTo: null,
  to: "bob@example.com",
  subject: "WIP subject",
  bodyText: "rich body",
  bodyJson: JSON.stringify({ mockText: "rich body (restored)" }),
  fromLocal: "sales",
  fromDomain: "example.com",
  fromName: "Shiny Sales",
  updated: Date.UTC(2026, 5, 9),
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
  vi.mocked(listThreads).mockResolvedValue(THREADS_RESP);
  vi.mocked(getCounts).mockResolvedValue({
    inbox: 0, starred: 0, sent: 0, all: 0, trash: 0, inboxUnread: 0, drafts: 2,
  });
  vi.mocked(getMe).mockResolvedValue({ email: "me@example.com" } as Me);
  vi.mocked(listDrafts).mockResolvedValue({
    drafts: [
      { id: DRAFT_ID, threadId: null, to: "bob@example.com", subject: "WIP subject", snippet: "rich body", updated: Date.UTC(2026, 5, 9) },
      { id: "99999999-8888-7777-6666-555555555555", threadId: "t9", to: "", subject: "", snippet: "", updated: Date.UTC(2026, 5, 8) },
    ],
  });
  vi.mocked(getDraft).mockResolvedValue(FULL);
});

describe("Drafts view", () => {
  it("shows a Drafts nav item with the server count and lists drafts", async () => {
    renderApp();
    const nav = await screen.findByRole("button", { name: /drafts/i });
    await waitFor(() => expect(nav).toHaveTextContent("2"));
    fireEvent.click(nav);
    await waitFor(() => expect(listDrafts).toHaveBeenCalled());
    const list = await screen.findByRole("list", { name: "Drafts" });
    expect(within(list).getByText("bob@example.com")).toBeInTheDocument();
    expect(within(list).getByText("WIP subject")).toBeInTheDocument();
    expect(within(list).getByText("(no recipients)")).toBeInTheDocument();
  });

  it("resumes a draft in the compose dialog (rich doc wins over plain text)", async () => {
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: /drafts/i }));
    fireEvent.click(await screen.findByText("WIP subject"));

    const dialog = await screen.findByRole("dialog");
    expect(getDraft).toHaveBeenCalledWith(DRAFT_ID);
    expect(within(dialog).getByLabelText("Remove bob@example.com")).toBeInTheDocument();
    expect(screen.getByLabelText("Subject")).toHaveValue("WIP subject");
    expect(screen.getByLabelText("From local part")).toHaveValue("sales");
    expect(screen.getByLabelText("From name")).toHaveValue("Shiny Sales");
    const body = (await within(dialog).findByLabelText("Message")) as HTMLTextAreaElement;
    expect(body.value).toBe("rich body (restored)");
  });

  it("deletes a draft from the list", async () => {
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: /drafts/i }));
    const list = await screen.findByRole("list", { name: "Drafts" });
    fireEvent.click(within(list).getByLabelText("Delete draft WIP subject"));
    await waitFor(() => expect(deleteDraft).toHaveBeenCalledWith(DRAFT_ID));
  });
});

describe("Compose draft autosave", () => {
  it("flushes a draft on close (typed content is never lost)", async () => {
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: /compose/i }));
    await screen.findByRole("dialog");
    fireEvent.change(await screen.findByLabelText("Message"), {
      target: { value: "half-written thought" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: /^close$/i })[0]);

    await waitFor(() => expect(putDraft).toHaveBeenCalledTimes(1));
    const [id, body] = vi.mocked(putDraft).mock.calls[0];
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body).toMatchObject({
      bodyText: "half-written thought",
      bodyJson: JSON.stringify({ mockText: "half-written thought" }),
      fromLocal: "hello",
    });
  });

  it("does NOT save a draft when the message was sent (send deletes, close-flush skips)", async () => {
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: /compose/i }));
    await screen.findByRole("dialog");
    fireEvent.change(screen.getByLabelText("Add recipient"), {
      target: { value: "bob@example.com" },
    });
    fireEvent.change(await screen.findByLabelText("Message"), {
      target: { value: "ship it" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    // Dialog closed by the success handler; the close-flush must not save.
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(putDraft).not.toHaveBeenCalled();
  });

  it("Discard deletes the backing draft and closes", async () => {
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: /compose/i }));
    await screen.findByRole("dialog");
    fireEvent.change(await screen.findByLabelText("Message"), {
      target: { value: "never mind" },
    });
    // Close (flush-saves the draft), then resume it and discard.
    fireEvent.click(screen.getAllByRole("button", { name: /^close$/i })[0]);
    await waitFor(() => expect(putDraft).toHaveBeenCalledTimes(1));
    const savedId = vi.mocked(putDraft).mock.calls[0][0] as string;

    vi.mocked(getDraft).mockResolvedValue({ ...FULL, id: savedId });
    fireEvent.click(await screen.findByRole("button", { name: /drafts/i }));
    fireEvent.click(await screen.findByText("WIP subject"));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: /discard/i }));

    await waitFor(() => expect(deleteDraft).toHaveBeenCalledWith(savedId));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // The discarded draft must not be resurrected by the close-flush.
    expect(putDraft).toHaveBeenCalledTimes(1);
  });
});
