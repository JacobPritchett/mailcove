// Inline reply send lifecycle: one send per reply, and a send that outlives the
// composer (the user switched threads) still finishes cleanly.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, within, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "../App";

vi.mock("../lib/api", () => ({
  ApiError: class ApiError extends Error {},
  listThreads: vi.fn(),
  getCounts: vi.fn(),
  mutateThread: vi.fn(() => Promise.resolve({ ok: true })),
  mutateThreads: vi.fn(() => Promise.resolve({ ok: true, count: 0 })),
  getThread: vi.fn(),
  getMe: vi.fn(() => Promise.resolve({ email: "me@example.com" })),
  getIdentities: vi.fn(() =>
    Promise.resolve({ identities: [], defaultLocal: "hello", defaultDomain: "example.com" }),
  ),
  send: vi.fn(),
  putDraft: vi.fn(() => Promise.resolve({ ok: true })),
  getDraftAttachments: vi.fn(() => Promise.resolve({ attachments: [] })),
  putDraftAttachments: vi.fn(() => Promise.resolve({ ok: true })),
  deleteDraft: vi.fn(() => Promise.resolve({ ok: true })),
  listDrafts: vi.fn(() => Promise.resolve({ drafts: [] })),
  getDraft: vi.fn(),
  getContacts: vi.fn(() => Promise.resolve({ contacts: [] })),
  attachmentUrl: (id: string, name: string) => `/api/attachments/${id}/${name}`,
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  Toaster: () => null,
}));

import { toast } from "sonner";
import { listThreads, getCounts, getThread, send, putDraft, deleteDraft } from "../lib/api";

const row = (id: string, subject: string) => ({
  thread_id: id, id: "m" + id, msg_from: "Alice <alice@example.com>", msg_to: "me@example.com",
  subject, snippet: "s", date: Date.now(), count: 1, anyUnread: 0, hasAttachments: 0, starred: 0, category: null,
});
const thread = (id: string) => ({
  thread_id: id,
  messages: [{
    id: "m" + id, thread_id: id, direction: "in", folder: "inbox", msg_from: "Alice <alice@example.com>",
    msg_to: "me@example.com", subject: "Subj " + id, snippet: "s", date: Date.now(), unread: 0,
    has_attachments: 0, msg_cc: null, message_id: "<mid>", in_reply_to: null,
    body: { text: "hello", html: "", attachments: [] },
  }],
});

function renderApp() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><App /></QueryClientProvider>);
}

async function openReply(subject: string, typed: string) {
  fireEvent.click(await screen.findByText(subject));
  fireEvent.click(await screen.findByRole("button", { name: "Reply" }));
  const inline = await screen.findByTestId("inline-reply");
  const body = await within(inline).findByLabelText("Message");
  fireEvent.change(body, { target: { value: typed } });
  return { inline, body };
}

const settle = (ms = 60) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listThreads).mockResolvedValue({
    threads: [row("t1", "Thread A"), row("t2", "Thread B")], unread: 0, user: "me",
  } as never);
  vi.mocked(getCounts).mockResolvedValue({ inbox: 2, starred: 0, sent: 0, all: 2, trash: 0, inboxUnread: 0 });
  vi.mocked(getThread).mockImplementation(async (id: string) => thread(id) as never);
});

describe("inline reply send", () => {
  it("Cmd+Enter twice sends one reply", async () => {
    vi.mocked(send).mockImplementation(() => new Promise(() => {}));
    renderApp();
    const { body } = await openReply("Thread A", "my reply");
    fireEvent.keyDown(body, { key: "Enter", metaKey: true });
    fireEvent.keyDown(body, { key: "Enter", metaKey: true });
    await waitFor(() => expect(send).toHaveBeenCalled());
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("disables Send while the reply is going out", async () => {
    vi.mocked(send).mockImplementation(() => new Promise(() => {}));
    renderApp();
    const { inline } = await openReply("Thread A", "my reply");
    const btn = within(inline).getByRole("button", { name: /send/i });
    fireEvent.click(btn);
    await waitFor(() => expect(btn).toBeDisabled());
  });

  it("switching threads mid-send does not save a draft of the sent reply, and still says Sent", async () => {
    let resolveSend!: (v: { ok: true; id: string }) => void;
    vi.mocked(send).mockImplementation(() => new Promise((r) => { resolveSend = r; }));
    renderApp();
    const { inline } = await openReply("Thread A", "my reply");
    fireEvent.click(within(inline).getByRole("button", { name: /send/i }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    fireEvent.click(await screen.findByText("Thread B"));
    await screen.findByRole("heading", { name: "Subj t2" });
    await act(async () => resolveSend({ ok: true, id: "x" }));
    await settle();

    expect(putDraft).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith("Sent ✓");
  });

  it("a reply that was autosaved, then sent across a thread switch, has its draft deleted", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let resolveSend!: (v: { ok: true; id: string }) => void;
      vi.mocked(send).mockImplementation(() => new Promise((r) => { resolveSend = r; }));
      renderApp();
      const { inline } = await openReply("Thread A", "my reply");
      await act(() => vi.advanceTimersByTimeAsync(1600));
      expect(putDraft).toHaveBeenCalledTimes(1);
      const draftId = vi.mocked(putDraft).mock.calls[0][0];

      fireEvent.click(within(inline).getByRole("button", { name: /send/i }));
      await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      fireEvent.click(await screen.findByText("Thread B"));
      await screen.findByRole("heading", { name: "Subj t2" });
      await act(async () => resolveSend({ ok: true, id: "x" }));

      await waitFor(() => expect(deleteDraft).toHaveBeenCalledWith(draftId));
      expect(putDraft).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a send that fails after the thread switch says so and keeps the reply as a draft", async () => {
    let rejectSend!: (e: Error) => void;
    vi.mocked(send).mockImplementation(() => new Promise((_r, rej) => { rejectSend = rej; }));
    renderApp();
    const { inline } = await openReply("Thread A", "my reply");
    fireEvent.click(within(inline).getByRole("button", { name: /send/i }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    fireEvent.click(await screen.findByText("Thread B"));
    await screen.findByRole("heading", { name: "Subj t2" });
    await act(async () => rejectSend(new Error("boom")));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/saved to Drafts/)));
    await waitFor(() => expect(putDraft).toHaveBeenCalledTimes(1));
    expect(vi.mocked(putDraft).mock.calls[0][1]).toMatchObject({ bodyText: "my reply", threadId: "t1" });
    expect(deleteDraft).not.toHaveBeenCalled();
  });

  it("a send finishing for one thread does not close a reply opened on another", async () => {
    let resolveSend!: (v: { ok: true; id: string }) => void;
    vi.mocked(send).mockImplementationOnce(() => new Promise((r) => { resolveSend = r; }));
    renderApp();
    const { inline } = await openReply("Thread A", "my reply");
    fireEvent.click(within(inline).getByRole("button", { name: /send/i }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    const second = await openReply("Thread B", "another reply");
    await act(async () => resolveSend({ ok: true, id: "x" }));
    await settle();
    expect(second.body).toBeInTheDocument();
    expect((second.body as HTMLTextAreaElement).value).toBe("another reply");
  });
});

describe("while a reply is being sent", () => {
  it("freezes the editor, discard, AI draft and the expand handoff", async () => {
    vi.mocked(send).mockImplementation(() => new Promise(() => {}));
    renderApp();
    const { inline, body } = await openReply("Thread A", "my reply");
    fireEvent.click(within(inline).getByRole("button", { name: /send/i }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    expect(body).toHaveAttribute("readonly");
    expect(within(inline).getByRole("button", { name: "Discard reply" })).toBeDisabled();
    expect(within(inline).getByRole("button", { name: "Open in full composer" })).toBeDisabled();
    expect(within(inline).getByRole("button", { name: /Draft with AI/ })).toBeDisabled();
  });

  it("gives everything back when the send fails", async () => {
    vi.mocked(send).mockRejectedValue(new Error("boom"));
    renderApp();
    const { inline, body } = await openReply("Thread A", "my reply");
    fireEvent.click(within(inline).getByRole("button", { name: /send/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Send failed"));
    await waitFor(() => expect(body).not.toHaveAttribute("readonly"));
    expect(within(inline).getByRole("button", { name: "Discard reply" })).not.toBeDisabled();
    expect(within(inline).getByRole("button", { name: "Open in full composer" })).not.toBeDisabled();
  });

  it("Cmd+Enter still sends when the editor has already consumed the key", async () => {
    // The real editor binds Mod-Enter and prevents its default before the
    // composer's handler sees it; the textarea mock does not, so do it here.
    vi.mocked(send).mockResolvedValue({ ok: true, id: "x" });
    renderApp();
    const { body } = await openReply("Thread A", "my reply");
    body.addEventListener("keydown", (e) => e.preventDefault());
    fireEvent.keyDown(body, { key: "Enter", metaKey: true });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  });

  it("Cmd+Enter during IME composition does not send", async () => {
    renderApp();
    const { body } = await openReply("Thread A", "my reply");
    fireEvent.keyDown(body, { key: "Enter", metaKey: true, isComposing: true });
    fireEvent.keyDown(body, { key: "Enter", metaKey: true, keyCode: 229 });
    await settle();
    expect(send).not.toHaveBeenCalled();
  });
});

describe("a send that fails after the composer is gone", () => {
  beforeEach(() => {
    localStorage.clear();
    // These are about a send that goes out at once (see undo-send.test.tsx
    // for one that is held first).
    localStorage.setItem("mailcove.undo-send", "0");
  });

  async function failAfterSwitch() {
    let rejectSend!: (e: Error) => void;
    vi.mocked(send).mockImplementationOnce(() => new Promise((_r, rej) => { rejectSend = rej; }));
    renderApp();
    const { inline } = await openReply("Thread A", "my reply");
    fireEvent.click(within(inline).getByRole("button", { name: /send/i }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByText("Thread B"));
    await screen.findByRole("heading", { name: "Subj t2" });
    return rejectSend;
  }

  it("only says the reply was saved to Drafts once it actually was", async () => {
    let resolvePut!: (v: { ok: true }) => void;
    vi.mocked(putDraft).mockImplementationOnce(() => new Promise((r) => { resolvePut = r; }));
    const rejectSend = await failAfterSwitch();
    await act(async () => rejectSend(new Error("boom")));
    await waitFor(() => expect(putDraft).toHaveBeenCalledTimes(1));
    await settle();
    expect(toast.error).not.toHaveBeenCalled();

    await act(async () => resolvePut({ ok: true }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/saved to Drafts/)));
  });

  it("when the draft cannot be saved either, says so, keeps a local copy, and restores it", async () => {
    vi.mocked(putDraft).mockRejectedValueOnce(new Error("offline"));
    const rejectSend = await failAfterSwitch();
    await act(async () => rejectSend(new Error("offline")));

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    const message = vi.mocked(toast.error).mock.calls[0][0] as string;
    expect(message).not.toMatch(/saved to Drafts/);
    expect(message).toMatch(/kept on this device/);

    // Back on the thread, opening the reply brings the text back.
    fireEvent.click(await screen.findByText("Thread A"));
    await screen.findByRole("heading", { name: "Subj t1" });
    fireEvent.click(await screen.findByRole("button", { name: "Reply" }));
    const inline = await screen.findByTestId("inline-reply");
    const body = (await within(inline).findByLabelText("Message")) as HTMLTextAreaElement;
    await waitFor(() => expect(body.value).toBe("my reply"));

    // Sending it for real clears the local copy: it does not come back again.
    vi.mocked(send).mockResolvedValueOnce({ ok: true, id: "x" });
    fireEvent.click(within(inline).getByRole("button", { name: /send/i }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Sent \u2713"));
    fireEvent.click(await screen.findByRole("button", { name: "Reply" }));
    const again = (await within(await screen.findByTestId("inline-reply")).findByLabelText("Message")) as HTMLTextAreaElement;
    await settle();
    expect(again.value).not.toContain("my reply");
  });

  it("discarding a restored reply clears the local copy", async () => {
    vi.mocked(putDraft).mockRejectedValueOnce(new Error("offline"));
    const rejectSend = await failAfterSwitch();
    await act(async () => rejectSend(new Error("offline")));
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));

    fireEvent.click(await screen.findByText("Thread A"));
    await screen.findByRole("heading", { name: "Subj t1" });
    fireEvent.click(await screen.findByRole("button", { name: "Reply" }));
    let inline = await screen.findByTestId("inline-reply");
    await waitFor(async () =>
      expect(((await within(inline).findByLabelText("Message")) as HTMLTextAreaElement).value).toBe("my reply"),
    );
    fireEvent.click(within(inline).getByRole("button", { name: "Discard reply" }));
    fireEvent.click(await screen.findByRole("button", { name: "Reply" }));
    inline = await screen.findByTestId("inline-reply");
    const body = (await within(inline).findByLabelText("Message")) as HTMLTextAreaElement;
    await settle();
    expect(body.value).not.toContain("my reply");
  });
});

