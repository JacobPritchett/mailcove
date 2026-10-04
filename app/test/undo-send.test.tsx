// Undo send, through the real App: Send holds the message, Undo puts the
// composer back as it was, and the guards around sending keep holding.
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
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), loading: vi.fn(), dismiss: vi.fn() }),
  Toaster: () => null,
}));

import { toast } from "sonner";
import { listThreads, getCounts, getThread, send, putDraft, deleteDraft } from "../lib/api";
import { flushHeld, resetOutboxForTest } from "../lib/outbox";

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

const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

/** The Undo button of the newest "Sending..." toast. */
function pressUndo() {
  const calls = vi.mocked(toast).mock.calls.filter((c) => c[0] === "Sending…");
  const action = calls[calls.length - 1][1]!.action as unknown as { onClick: () => void };
  act(() => action.onClick());
}
const heldToasts = () => vi.mocked(toast).mock.calls.filter((c) => c[0] === "Sending…").length;

async function compose(fields: { to: string; cc?: string; bcc?: string; subject: string; body: string }) {
  fireEvent.click(screen.getByRole("button", { name: /compose/i }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.change(screen.getByLabelText("Add recipient"), { target: { value: fields.to } });
  if (fields.cc) {
    fireEvent.click(within(dialog).getByRole("button", { name: "Cc" }));
    fireEvent.change(screen.getByLabelText("Add Cc recipient"), { target: { value: fields.cc } });
  }
  if (fields.bcc) {
    fireEvent.click(within(dialog).getByRole("button", { name: "Bcc" }));
    fireEvent.change(screen.getByLabelText("Add Bcc recipient"), { target: { value: fields.bcc } });
  }
  fireEvent.change(screen.getByLabelText("Subject"), { target: { value: fields.subject } });
  fireEvent.change(await screen.findByLabelText("Message"), { target: { value: fields.body } });
  return dialog;
}
const sendButton = () => screen.getByRole("button", { name: /^send$/i });

async function openReply(subject: string, typed: string) {
  fireEvent.click(await screen.findByText(subject));
  fireEvent.click(await screen.findByRole("button", { name: "Reply" }));
  const inline = await screen.findByTestId("inline-reply");
  const body = await within(inline).findByLabelText("Message");
  fireEvent.change(body, { target: { value: typed } });
  return inline;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  localStorage.setItem("mailcove.undo-send", "10");
  resetOutboxForTest();
  vi.mocked(listThreads).mockResolvedValue({
    threads: [row("t1", "Thread A"), row("t2", "Thread B")], unread: 0, user: "me",
  } as never);
  vi.mocked(getCounts).mockResolvedValue({ inbox: 2, starred: 0, sent: 0, all: 2, trash: 0, inboxUnread: 0 } as never);
  vi.mocked(getThread).mockImplementation((id: string) => Promise.resolve(thread(id) as never));
  vi.mocked(send).mockResolvedValue({ ok: true, id: "sent-1" });
  vi.mocked(putDraft).mockResolvedValue({ ok: true });
});

describe("undo send: the compose dialog", () => {
  it("holds the message: the draft is saved first, the dialog closes, nothing is sent yet", async () => {
    renderApp();
    await compose({ to: "bob@example.com", subject: "Greetings", body: "hi there" });
    fireEvent.click(sendButton());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(putDraft).toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(heldToasts()).toBe(1);
    // No "Draft saved": the message is on its way, not put aside.
    expect(toast.success).not.toHaveBeenCalledWith("Draft saved");
    // The page goes away: it is sent at once, naming its draft.
    act(() => flushHeld());
    expect(send).toHaveBeenCalledTimes(1);
    const [payload, opts] = vi.mocked(send).mock.calls[0];
    expect(payload).toMatchObject({ to: ["bob@example.com"], subject: "Greetings", text: "hi there" });
    expect((payload as { draftId?: string }).draftId).toBe(vi.mocked(putDraft).mock.calls[0][0]);
    expect(opts).toEqual({ keepalive: true });
    await settle();
    // The Worker deletes the draft of a held message; the client must not
    // race it with a delete of its own, before or after.
    expect(deleteDraft).not.toHaveBeenCalled();
  });

  it("Undo reopens the dialog as it was: recipients, Cc, Bcc, subject and body", async () => {
    renderApp();
    await compose({
      to: "bob@example.com", cc: "carol@example.com", bcc: "dan@example.com", subject: "Greetings", body: "hi there",
    });
    fireEvent.click(sendButton());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    pressUndo();
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("bob@example.com")).toBeInTheDocument();
    expect(within(dialog).getByText("carol@example.com")).toBeInTheDocument();
    expect(within(dialog).getByText("dan@example.com")).toBeInTheDocument();
    expect(screen.getByLabelText("Subject")).toHaveValue("Greetings");
    expect(await screen.findByLabelText("Message")).toHaveValue("hi there");
    // Taken back for good.
    act(() => flushHeld());
    await settle();
    expect(send).not.toHaveBeenCalled();
    // And it is the same draft, not a second one.
    const draftId = vi.mocked(putDraft).mock.calls[0][0];
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Greetings, again" } });
    fireEvent.click(sendButton());
    await waitFor(() => expect(heldToasts()).toBe(2));
    act(() => flushHeld());
    expect(send).toHaveBeenCalledTimes(1);
    expect(vi.mocked(send).mock.calls[0][0]).toMatchObject({ subject: "Greetings, again", draftId });
  });

  it("Cmd+Enter holds the same way the button does", async () => {
    renderApp();
    await compose({ to: "bob@example.com", subject: "Greetings", body: "hi there" });
    fireEvent.keyDown(screen.getByLabelText("Subject"), { key: "Enter", metaKey: true });
    await waitFor(() => expect(heldToasts()).toBe(1));
    expect(send).not.toHaveBeenCalled();
  });

  it("a double press holds one message, not two", async () => {
    renderApp();
    await compose({ to: "bob@example.com", subject: "Greetings", body: "hi there" });
    fireEvent.click(sendButton());
    fireEvent.keyDown(screen.getByLabelText("Subject"), { key: "Enter", metaKey: true });
    await waitFor(() => expect(heldToasts()).toBe(1));
    await settle();
    act(() => flushHeld());
    expect(heldToasts()).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("a second message can be sent while the first is still held", async () => {
    renderApp();
    await compose({ to: "bob@example.com", subject: "One", body: "first" });
    fireEvent.click(sendButton());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await compose({ to: "carol@example.com", subject: "Two", body: "second" });
    fireEvent.click(sendButton());
    await waitFor(() => expect(heldToasts()).toBe(2));
    act(() => flushHeld());
    expect(vi.mocked(send).mock.calls.map((c) => c[0].subject)).toEqual(["One", "Two"]);
    // Each names its own draft.
    const ids = vi.mocked(send).mock.calls.map((c) => (c[0] as { draftId?: string }).draftId);
    expect(new Set(ids).size).toBe(2);
  });

  it("Undo while another message is being written keeps that one as a draft and brings the first back", async () => {
    renderApp();
    await compose({ to: "bob@example.com", subject: "One", body: "first" });
    fireEvent.click(sendButton());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await compose({ to: "carol@example.com", subject: "Two", body: "second" });
    pressUndo();
    await waitFor(() => expect(screen.getByLabelText("Subject")).toHaveValue("One"));
    expect(toast.success).toHaveBeenCalledWith("Draft saved");
    const saved = vi.mocked(putDraft).mock.calls.map((c) => c[1].subject);
    expect(saved).toContain("Two");
  });

  it("sends at once when the draft cannot be saved, and a failure keeps the dialog open", async () => {
    vi.mocked(putDraft).mockRejectedValue(new Error("offline"));
    vi.mocked(send).mockRejectedValue(new Error("offline"));
    renderApp();
    await compose({ to: "bob@example.com", subject: "Greetings", body: "hi there" });
    fireEvent.click(sendButton());
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(heldToasts()).toBe(0);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Send failed"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText("Subject")).toHaveValue("Greetings");
  });

  it("sends at once with the delay turned off", async () => {
    localStorage.setItem("mailcove.undo-send", "0");
    renderApp();
    await compose({ to: "bob@example.com", subject: "Greetings", body: "hi there" });
    fireEvent.click(sendButton());
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(heldToasts()).toBe(0);
    expect(vi.mocked(send).mock.calls[0][0]).not.toHaveProperty("draftId");
  });

  it("z takes back a held message before it undoes a thread action", async () => {
    renderApp();
    await compose({ to: "bob@example.com", subject: "Greetings", body: "hi there" });
    fireEvent.click(sendButton());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.keyDown(document, { key: "z" });
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText("Subject")).toHaveValue("Greetings");
  });
});

describe("undo send: the inline reply", () => {
  it("holds the reply and closes the composer", async () => {
    renderApp();
    await openReply("Thread A", "my reply");
    fireEvent.click(within(screen.getByTestId("inline-reply")).getByRole("button", { name: /^send$/i }));
    await waitFor(() => expect(heldToasts()).toBe(1));
    expect(send).not.toHaveBeenCalled();
    expect(putDraft).toHaveBeenCalled();
    act(() => flushHeld());
    expect(send).toHaveBeenCalledTimes(1);
    expect(vi.mocked(send).mock.calls[0][0]).toMatchObject({
      to: "alice@example.com", threadId: "t1", inReplyTo: "<mid>",
      draftId: vi.mocked(putDraft).mock.calls[0][0],
    });
    await settle();
    expect(deleteDraft).not.toHaveBeenCalled();
  });

  it("Undo puts the reply back where it was written, on the same draft", async () => {
    renderApp();
    await openReply("Thread A", "my reply");
    fireEvent.click(within(screen.getByTestId("inline-reply")).getByRole("button", { name: /^send$/i }));
    await waitFor(() => expect(heldToasts()).toBe(1));
    const draftId = vi.mocked(putDraft).mock.calls[0][0];
    pressUndo();
    await waitFor(async () =>
      expect(await within(screen.getByTestId("inline-reply")).findByLabelText("Message")).toHaveValue("my reply"),
    );
    // Inline, not the dialog.
    expect(screen.queryByRole("dialog")).toBeNull();
    // Sent again: still one draft row.
    fireEvent.click(within(screen.getByTestId("inline-reply")).getByRole("button", { name: /^send$/i }));
    await waitFor(() => expect(heldToasts()).toBe(2));
    act(() => flushHeld());
    expect(send).toHaveBeenCalledTimes(1);
    expect(vi.mocked(send).mock.calls[0][0]).toMatchObject({ text: "my reply", draftId });
    expect(new Set(vi.mocked(putDraft).mock.calls.map((c) => c[0]))).toEqual(new Set([draftId]));
  });

  it("Undo after moving to another conversation opens the reply in the full composer", async () => {
    renderApp();
    await openReply("Thread A", "my reply");
    fireEvent.click(within(screen.getByTestId("inline-reply")).getByRole("button", { name: /^send$/i }));
    await waitFor(() => expect(heldToasts()).toBe(1));
    fireEvent.click(screen.getByText("Thread B"));
    await screen.findByText("Subj t2");
    pressUndo();
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("alice@example.com")).toBeInTheDocument();
    expect(await within(dialog).findByLabelText("Message")).toHaveValue("my reply");
    act(() => flushHeld());
    expect(send).not.toHaveBeenCalled();
  });

  it("a reply sent while its conversation is being left is held once and not saved as a second draft", async () => {
    renderApp();
    await openReply("Thread A", "my reply");
    fireEvent.click(within(screen.getByTestId("inline-reply")).getByRole("button", { name: /^send$/i }));
    fireEvent.click(screen.getByText("Thread B"));
    await waitFor(() => expect(heldToasts()).toBe(1));
    await settle(80);
    expect(new Set(vi.mocked(putDraft).mock.calls.map((c) => c[0])).size).toBe(1);
    act(() => flushHeld());
    expect(send).toHaveBeenCalledTimes(1);
  });
});
