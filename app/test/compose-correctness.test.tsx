// Compose dialog correctness: what Enter does, that one send is one email,
// where focus lands, and that a resumed draft's files are really there before
// anything is sent or synced.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
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
  send: vi.fn(),
  putDraft: vi.fn(() => Promise.resolve({ ok: true })),
  getDraftAttachments: vi.fn(() => Promise.resolve({ attachments: [] })),
  putDraftAttachments: vi.fn(() => Promise.resolve({ ok: true })),
  deleteDraft: vi.fn(() => Promise.resolve({ ok: true })),
  listDrafts: vi.fn(),
  getDraft: vi.fn(),
  getContacts: vi.fn(() => Promise.resolve({ contacts: [] })),
  suggestCompletion: vi.fn(() => Promise.resolve({ suggestion: "" })),
  attachmentUrl: (id: string, name: string) => `/api/attachments/${id}/${name}`,
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  Toaster: () => null,
}));

import { toast } from "sonner";
import {
  listThreads,
  getCounts,
  getMe,
  send,
  putDraft,
  deleteDraft,
  listDrafts,
  getDraft,
  getDraftAttachments,
  putDraftAttachments,
} from "../lib/api";

const THREADS_RESP: ThreadsResponse = { threads: [], unread: 0, user: "hello@example.com" };

const DRAFT_ID = "11111111-2222-3333-4444-555555555555";
const FULL: DraftFull = {
  id: DRAFT_ID,
  threadId: null,
  inReplyTo: null,
  to: "bob@example.com",
  subject: "WIP subject",
  bodyText: "draft body",
  bodyJson: "",
  fromLocal: "hello",
  fromDomain: "example.com",
  fromName: "",
  attachments: [{ name: "stored.pdf", type: "application/pdf", size: 6 }],
  updated: Date.UTC(2026, 5, 9),
};
const STORED = { name: "stored.pdf", type: "application/pdf", size: 6, data: "c3RvcmVk" };

function renderApp() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>,
  );
}

async function openCompose() {
  fireEvent.click(screen.getAllByRole("button", { name: /compose/i })[0]);
  return screen.findByRole("dialog");
}

async function openDraft() {
  fireEvent.click(screen.getByRole("button", { name: /^Drafts/ }));
  fireEvent.click(await screen.findByText("WIP subject"));
  return screen.findByRole("dialog");
}

function attach(name: string, body = "bytes") {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File([body], name, { type: "text/plain" })] } });
}

/** Let pending promise callbacks and zero-delay timers run. */
const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listThreads).mockResolvedValue(THREADS_RESP);
  vi.mocked(getCounts).mockResolvedValue({
    inbox: 0, starred: 0, sent: 0, all: 0, trash: 0, inboxUnread: 0, drafts: 1,
  });
  vi.mocked(getMe).mockResolvedValue({ email: "hello@example.com" } as Me);
  vi.mocked(send).mockResolvedValue({ ok: true, id: "sent-1" });
  vi.mocked(listDrafts).mockResolvedValue({
    drafts: [
      { id: DRAFT_ID, threadId: null, to: "bob@example.com", subject: "WIP subject", snippet: "draft body", attachmentCount: 1, updated: Date.UTC(2026, 5, 9) },
    ],
  });
  vi.mocked(getDraft).mockResolvedValue(FULL);
  vi.mocked(getDraftAttachments).mockResolvedValue({ attachments: [STORED] });
});

describe("Enter in single-line compose fields", () => {
  it.each(["Subject", "From name", "From local part"])(
    "plain Enter in %s does not submit the form",
    async (label) => {
      renderApp();
      await openCompose();
      fireEvent.change(screen.getByLabelText("Add recipient"), { target: { value: "bob@example.com" } });
      const field = screen.getByLabelText(label);
      // dispatchEvent returns false when the default (implicit submission in a
      // real browser) was prevented.
      const notPrevented = fireEvent.keyDown(field, { key: "Enter" });
      expect(notPrevented).toBe(false);
      await settle();
      expect(send).not.toHaveBeenCalled();
    },
  );

  it("Enter in Subject moves focus to the body", async () => {
    renderApp();
    await openCompose();
    const body = await screen.findByLabelText("Message");
    const subject = screen.getByLabelText("Subject");
    subject.focus();
    fireEvent.keyDown(subject, { key: "Enter" });
    expect(document.activeElement).toBe(body);
  });

  it("Cmd+Enter in Subject still sends", async () => {
    renderApp();
    await openCompose();
    await screen.findByLabelText("Message");
    fireEvent.change(screen.getByLabelText("Add recipient"), { target: { value: "bob@example.com" } });
    fireEvent.keyDown(screen.getByLabelText("Subject"), { key: "Enter", metaKey: true });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  });
});

describe("double send", () => {
  it("Cmd+Enter twice before the body serializes sends one message", async () => {
    vi.mocked(send).mockImplementation(() => new Promise(() => {}));
    renderApp();
    const dialog = await openCompose();
    fireEvent.change(screen.getByLabelText("Add recipient"), { target: { value: "bob@example.com" } });
    fireEvent.change(await screen.findByLabelText("Message"), { target: { value: "hi" } });
    const form = dialog.querySelector("form")!;
    fireEvent.keyDown(form, { key: "Enter", metaKey: true });
    fireEvent.keyDown(form, { key: "Enter", metaKey: true });
    await waitFor(() => expect(send).toHaveBeenCalled());
    await settle(50);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("disables Send as soon as the first submit is accepted", async () => {
    vi.mocked(send).mockImplementation(() => new Promise(() => {}));
    renderApp();
    const dialog = await openCompose();
    fireEvent.change(screen.getByLabelText("Add recipient"), { target: { value: "bob@example.com" } });
    await screen.findByLabelText("Message");
    fireEvent.submit(dialog.querySelector("form")!);
    expect(dialog.querySelector('button[type="submit"]')).toBeDisabled();
  });

  it("allows another attempt after a failed send", async () => {
    vi.mocked(send).mockRejectedValueOnce(new Error("boom"));
    renderApp();
    const dialog = await openCompose();
    fireEvent.change(screen.getByLabelText("Add recipient"), { target: { value: "bob@example.com" } });
    await screen.findByLabelText("Message");
    const form = dialog.querySelector("form")!;
    fireEvent.submit(form);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(dialog.querySelector('button[type="submit"]')).not.toBeDisabled());
    fireEvent.submit(form);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  });
});

describe("initial focus", () => {
  it("a new message focuses the To input", async () => {
    renderApp();
    await openCompose();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Add recipient")));
  });

  it("a resumed draft with recipients focuses the body", async () => {
    renderApp();
    await openDraft();
    const body = await screen.findByLabelText("Message");
    await waitFor(() => expect(document.activeElement).toBe(body));
  });
});

describe("attachments and drafts", () => {
  it("adding a file alone schedules an autosave", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderApp();
      await openCompose();
      attach("report.pdf");
      await screen.findByText("report.pdf");
      await act(() => vi.advanceTimersByTimeAsync(1600));
      expect(putDraft).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(putDraftAttachments).toHaveBeenCalledTimes(1));
    } finally {
      vi.useRealTimers();
    }
  });

  it("no longer claims files are left out of drafts", async () => {
    renderApp();
    await openCompose();
    attach("report.pdf");
    await screen.findByText("report.pdf");
    expect(screen.queryByText(/not saved in drafts/i)).not.toBeInTheDocument();
    expect(screen.getByText(/included when this draft saves successfully/i)).toBeInTheDocument();
  });

  it("shows a loading state and blocks Send until a resumed draft's files arrive", async () => {
    let resolve!: (v: { attachments: (typeof STORED)[] }) => void;
    vi.mocked(getDraftAttachments).mockImplementation(() => new Promise((r) => { resolve = r; }));
    renderApp();
    const dialog = await openDraft();
    await screen.findByLabelText("Message");
    expect(await screen.findByText(/Loading attachments/i)).toBeInTheDocument();
    const submit = dialog.querySelector('button[type="submit"]')!;
    expect(submit).toBeDisabled();

    // Cmd+Enter must not slip past the disabled button.
    fireEvent.keyDown(dialog.querySelector("form")!, { key: "Enter", metaKey: true });
    await settle();
    expect(send).not.toHaveBeenCalled();

    await act(async () => resolve({ attachments: [STORED] }));
    expect(await screen.findByText("stored.pdf")).toBeInTheDocument();
    expect(submit).not.toBeDisabled();
    fireEvent.submit(dialog.querySelector("form")!);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(vi.mocked(send).mock.calls[0][0].attachments).toEqual([
      { filename: "stored.pdf", type: "application/pdf", data: "c3RvcmVk" },
    ]);
  });

  it("keeps a file added while the stored set is still loading", async () => {
    let resolve!: (v: { attachments: (typeof STORED)[] }) => void;
    vi.mocked(getDraftAttachments).mockImplementation(() => new Promise((r) => { resolve = r; }));
    renderApp();
    await openDraft();
    await screen.findByLabelText("Message");
    attach("new.txt");
    await screen.findByText("new.txt");
    await act(async () => resolve({ attachments: [STORED] }));
    expect(await screen.findByText("stored.pdf")).toBeInTheDocument();
    expect(screen.getByText("new.txt")).toBeInTheDocument();
  });

  it("a failed fetch is shown, blocks Send, and never overwrites the stored set", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.mocked(getDraftAttachments).mockRejectedValueOnce(new Error("network"));
      renderApp();
      const dialog = await openDraft();
      await screen.findByLabelText("Message");
      expect(await screen.findByText(/Couldn't load the files saved with this draft/i)).toBeInTheDocument();
      expect(dialog.querySelector('button[type="submit"]')).toBeDisabled();

      attach("new.txt");
      await screen.findByText("new.txt");
      await act(() => vi.advanceTimersByTimeAsync(1600));
      // The body may autosave, but the stored files must not be replaced by a
      // set that is missing them.
      expect(putDraftAttachments).not.toHaveBeenCalled();

      // Retry succeeds: the stored file joins the one added meanwhile.
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(await screen.findByText("stored.pdf")).toBeInTheDocument();
      expect(screen.getByText("new.txt")).toBeInTheDocument();
      expect(dialog.querySelector('button[type="submit"]')).not.toBeDisabled();
      await act(() => vi.advanceTimersByTimeAsync(1600));
      await waitFor(() => expect(putDraftAttachments).toHaveBeenCalledTimes(1));
      expect(vi.mocked(putDraftAttachments).mock.calls[0][1].map((a) => a.name)).toEqual([
        "stored.pdf",
        "new.txt",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not delete the draft or send while its files failed to load", async () => {
    vi.mocked(getDraftAttachments).mockRejectedValue(new Error("network"));
    renderApp();
    const dialog = await openDraft();
    await screen.findByText(/Couldn't load the files saved with this draft/i);
    fireEvent.keyDown(dialog.querySelector("form")!, { key: "Enter", metaKey: true });
    await settle();
    expect(send).not.toHaveBeenCalled();
    expect(deleteDraft).not.toHaveBeenCalled();
  });
});

describe("a send that outlives its compose session", () => {
  const OTHER_ID = "99999999-8888-7777-6666-555555555555";

  function twoDrafts() {
    vi.mocked(listDrafts).mockResolvedValue({
      drafts: [
        { id: DRAFT_ID, threadId: null, to: "bob@example.com", subject: "WIP subject", snippet: "draft body", attachmentCount: 0, updated: 2 },
        { id: OTHER_ID, threadId: null, to: "carol@example.com", subject: "Second draft", snippet: "other", attachmentCount: 0, updated: 1 },
      ],
    });
    vi.mocked(getDraft).mockImplementation(async (id: string) =>
      id === DRAFT_ID
        ? { ...FULL, attachments: [] }
        : { ...FULL, id: OTHER_ID, to: "carol@example.com", subject: "Second draft", bodyText: "other body", attachments: [] },
    );
    vi.mocked(getDraftAttachments).mockResolvedValue({ attachments: [] });
  }

  async function sendAThenOpenB() {
    twoDrafts();
    let settleSend!: { resolve: (v: { ok: true; id: string }) => void; reject: (e: Error) => void };
    vi.mocked(send).mockImplementationOnce(
      () => new Promise((resolve, reject) => { settleSend = { resolve, reject }; }),
    );
    renderApp();
    const dialogA = await openDraft();
    await screen.findByLabelText("Message");
    await waitFor(() => expect(dialogA.querySelector('button[type="submit"]')).not.toBeDisabled());
    fireEvent.submit(dialogA.querySelector("form")!);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    // Header X stays enabled while sending.
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    fireEvent.click(await screen.findByText("Second draft"));
    await screen.findByRole("dialog");
    await waitFor(() => expect((screen.getByLabelText("Subject") as HTMLInputElement).value).toBe("Second draft"));
    return settleSend;
  }

  it("on success deletes the draft it sent, not the one now open, and leaves that composer alone", async () => {
    const settleSend = await sendAThenOpenB();
    await act(async () => settleSend.resolve({ ok: true, id: "sent-a" }));

    await waitFor(() => expect(deleteDraft).toHaveBeenCalledWith(DRAFT_ID));
    await settle(60);
    expect(deleteDraft).not.toHaveBeenCalledWith(OTHER_ID);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect((screen.getByLabelText("Subject") as HTMLInputElement).value).toBe("Second draft");
    expect(toast.success).toHaveBeenCalledWith("Sent \u2713");
    // The open draft can still be sent.
    expect(screen.getByRole("dialog").querySelector('button[type="submit"]')).not.toBeDisabled();
  });

  it("on failure says so without touching the composer now open", async () => {
    const settleSend = await sendAThenOpenB();
    await act(async () => settleSend.reject(new Error("boom")));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Send failed"));
    expect(deleteDraft).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    expect((screen.getByLabelText("Subject") as HTMLInputElement).value).toBe("Second draft");
    // The other message's error is not shown as this one's.
    expect(dialog.textContent).not.toMatch(/boom/);
    expect(dialog.querySelector('button[type="submit"]')).not.toBeDisabled();
  });
});

describe("draft attachment fetches belong to one opening of the dialog", () => {
  it("reopening the same draft mid-fetch neither doubles the files nor releases the gate early", async () => {
    const pending: ((v: { attachments: (typeof STORED)[] }) => void)[] = [];
    vi.mocked(getDraftAttachments).mockImplementation(() => new Promise((r) => { pending.push(r); }));
    renderApp();
    await openDraft();
    await screen.findByText(/Loading attachments/i);
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const dialog = await openDraft();
    await screen.findByText(/Loading attachments/i);
    expect(pending).toHaveLength(2);

    // The first opening's fetch lands late: it is not this session's.
    await act(async () => pending[0]({ attachments: [STORED] }));
    expect(screen.queryByText("stored.pdf")).not.toBeInTheDocument();
    expect(screen.getByText(/Loading attachments/i)).toBeInTheDocument();
    expect(dialog.querySelector('button[type="submit"]')).toBeDisabled();

    await act(async () => pending[1]({ attachments: [STORED] }));
    expect(await screen.findAllByText("stored.pdf")).toHaveLength(1);
    expect(dialog.querySelector('button[type="submit"]')).not.toBeDisabled();
  });
});

describe("discarding a draft's unreadable files", () => {
  async function openFailed() {
    vi.mocked(getDraftAttachments).mockRejectedValue(new Error("network"));
    renderApp();
    const dialog = await openDraft();
    await screen.findByText(/Couldn't load the files saved with this draft/i);
    return dialog;
  }

  it("is named for what it does", async () => {
    await openFailed();
    expect(screen.getByRole("button", { name: "Discard saved files" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Continue without/ })).not.toBeInTheDocument();
  });

  it("with nothing newly staged, stores the now-empty set straight away", async () => {
    const dialog = await openFailed();
    fireEvent.click(screen.getByRole("button", { name: "Discard saved files" }));
    await waitFor(() => expect(putDraftAttachments).toHaveBeenCalledWith(DRAFT_ID, []));
    expect(dialog.querySelector('button[type="submit"]')).not.toBeDisabled();
  });

  it("with a newly staged file, stores exactly that file, and only because the user chose to", async () => {
    await openFailed();
    attach("new.txt");
    await screen.findByText("new.txt");
    await settle(60);
    expect(putDraftAttachments).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Discard saved files" }));
    await waitFor(() => expect(putDraftAttachments).toHaveBeenCalledTimes(1));
    expect(vi.mocked(putDraftAttachments).mock.calls[0][1].map((a) => a.name)).toEqual(["new.txt"]);
  });
});

describe("IME composition and already-handled keys", () => {
  it("Enter that commits a composition in Subject is left alone", async () => {
    renderApp();
    await openCompose();
    await screen.findByLabelText("Message");
    const subject = screen.getByLabelText("Subject");
    subject.focus();
    expect(fireEvent.keyDown(subject, { key: "Enter", isComposing: true })).toBe(true);
    expect(fireEvent.keyDown(subject, { key: "Enter", keyCode: 229 })).toBe(true);
    expect(document.activeElement).toBe(subject);
  });

  it("Cmd+Enter during composition does not send", async () => {
    renderApp();
    const dialog = await openCompose();
    await screen.findByLabelText("Message");
    fireEvent.change(screen.getByLabelText("Add recipient"), { target: { value: "bob@example.com" } });
    fireEvent.keyDown(dialog.querySelector("form")!, { key: "Enter", metaKey: true, isComposing: true });
    await settle();
    expect(send).not.toHaveBeenCalled();
  });

  it("Enter during composition in To does not commit a half-typed recipient", async () => {
    renderApp();
    await openCompose();
    const to = screen.getByLabelText("Add recipient") as HTMLInputElement;
    fireEvent.change(to, { target: { value: "bob@example.com" } });
    expect(fireEvent.keyDown(to, { key: "Enter", isComposing: true })).toBe(true);
    expect(to.value).toBe("bob@example.com");
    expect(screen.queryByRole("button", { name: "Remove bob@example.com" })).not.toBeInTheDocument();
  });

  it("Enter during composition in Cc does not commit a half-typed recipient", async () => {
    renderApp();
    await openCompose();
    fireEvent.click(screen.getByRole("button", { name: /^Cc/ }));
    const cc = (await screen.findByLabelText("Add Cc recipient")) as HTMLInputElement;
    fireEvent.change(cc, { target: { value: "carol@example.com" } });
    expect(fireEvent.keyDown(cc, { key: "Enter", isComposing: true })).toBe(true);
    expect(cc.value).toBe("carol@example.com");
  });
});



it("does not claim a closed draft was saved before the request succeeds", async () => {
  let finish!: () => void;
  vi.mocked(putDraft).mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ ok: true }); }));
  renderApp();
  await openCompose();
  fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Save carefully" } });
  fireEvent.click(screen.getAllByRole("button", { name: /^Close$/ }).at(-1)!);
  await waitFor(() => expect(putDraft).toHaveBeenCalled());
  expect(toast.success).not.toHaveBeenCalledWith("Draft saved");
  await act(async () => finish());
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Draft saved"));
});
