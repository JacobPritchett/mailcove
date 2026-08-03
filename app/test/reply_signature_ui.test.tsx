// Replies went out unsigned while new messages were signed. Seeding a reply is
// the risky half: the body already holds a quote block, the signature has to go
// above it without disturbing it, and the identity list arrives AFTER the
// composer opens - so the seed can race whatever the user is typing.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
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
  getIdentities: vi.fn(),
  send: vi.fn(),
  putDraft: vi.fn(() => Promise.resolve({ ok: true })),
  deleteDraft: vi.fn(() => Promise.resolve({ ok: true })),
  listDrafts: vi.fn(() => Promise.resolve({ drafts: [] })),
  getDraft: vi.fn(),
  getContacts: vi.fn(() => Promise.resolve({ contacts: [] })),
  draftReply: vi.fn(() => Promise.resolve({ ok: true, draft: "AI DRAFT." })),
  attachmentUrl: (id: string, name: string) => `/api/attachments/${id}/${name}`,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
  Toaster: () => null,
}));

import { listThreads, getCounts, getThread, getMe, getIdentities, send, putDraft } from "../lib/api";

const SIG = "Sam Rivera\nExample Co";

const ROW: ThreadListRow = {
  thread_id: "t1",
  id: "m1",
  msg_from: "Alice <alice@example.com>",
  msg_to: "hello@example.com",
  subject: "Hello from Alice",
  snippet: "just checking in",
  date: Date.UTC(2026, 5, 3, 16, 41),
  count: 1,
  anyUnread: 1,
  hasAttachments: 0,
  starred: 0,
  category: null,
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
      msg_to: "hello@example.com",
      subject: "Hello from Alice",
      snippet: "just checking in",
      date: Date.UTC(2026, 5, 3, 16, 41),
      unread: 1,
      has_attachments: 0,
      msg_cc: null,
      message_id: "<mid-1@example.com>",
      in_reply_to: null,
      body: { text: "just checking in\nbody text", html: "", attachments: [] },
    },
  ],
};

const IDENTITIES = {
  identities: [
    { domain: "example.com", sendingDomain: "send.example.com", displayName: "Example", signature: SIG },
  ],
  defaultLocal: "hello",
  defaultDomain: "example.com",
};

function renderApp() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
}

async function openReply() {
  renderApp();
  fireEvent.click(await screen.findByText("Hello from Alice"));
  fireEvent.click(await screen.findByRole("button", { name: "Reply" }));
  const inline = await screen.findByTestId("inline-reply");
  return {
    inline,
    body: (await within(inline).findByLabelText("Message")) as HTMLTextAreaElement,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listThreads).mockResolvedValue({ threads: [ROW], unread: 1, user: "hello@example.com" } as ThreadsResponse);
  vi.mocked(getCounts).mockResolvedValue({ inbox: 1, starred: 0, sent: 0, all: 1, trash: 0, inboxUnread: 1 });
  vi.mocked(getThread).mockResolvedValue(THREAD);
  vi.mocked(getMe).mockResolvedValue({ email: "hello@example.com" } as Me);
  vi.mocked(getIdentities).mockResolvedValue(IDENTITIES);
  vi.mocked(send).mockResolvedValue({ ok: true, id: "sent-1" });
});

describe("signature on replies", () => {
  it("seeds the signature ABOVE the quoted history", async () => {
    const { body } = await openReply();

    await waitFor(() => expect(body.value).toContain(SIG));
    // Order is the point: the sign-off belongs to the reply, not the history.
    expect(body.value.indexOf(SIG)).toBeLessThan(body.value.indexOf("just checking in"));
  });

  it("keeps the whole quoted history, in order, below the signature", async () => {
    const { body } = await openReply();

    await waitFor(() => expect(body.value).toContain(SIG));
    // The mirror is the editor's text, so the "> " markers are gone (they are a
    // <blockquote> now). Nothing may be DROPPED, and the order must hold.
    expect(body.value).toContain("just checking in");
    expect(body.value).toContain("body text");
    expect(body.value.indexOf("just checking in")).toBeLessThan(body.value.indexOf("body text"));
    expect(body.value.startsWith("\n\n")).toBe(true);
  });

  it("actually sends the signature", async () => {
    const { inline, body } = await openReply();
    await waitFor(() => expect(body.value).toContain(SIG));

    fireEvent.change(body, { target: { value: `thanks!${body.value}` } });
    fireEvent.click(within(inline).getByRole("button", { name: /^send$/i }));

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(vi.mocked(send).mock.calls[0][0]).toEqual(
      expect.objectContaining({ text: expect.stringContaining(SIG) }),
    );
  });

  it("does not overwrite what the user typed when identities land late", async () => {
    // The identities query is gated on the composer opening, so this race is
    // the normal case on a cold cache, not an edge case.
    let release!: (v: typeof IDENTITIES) => void;
    vi.mocked(getIdentities).mockReturnValue(
      new Promise<typeof IDENTITIES>((res) => {
        release = res;
      }),
    );

    const { body } = await openReply();
    fireEvent.change(body, { target: { value: "thanks, will do!" } });

    release(IDENTITIES);
    await waitFor(() => expect(vi.mocked(getIdentities)).toHaveBeenCalled());

    // Give the seeding effect every chance to run before asserting it did not.
    await new Promise((r) => setTimeout(r, 50));
    expect(body.value).toBe("thanks, will do!");
    expect(body.value).not.toContain(SIG);
  });

  it("seeds nothing when the sending domain has no signature", async () => {
    vi.mocked(getIdentities).mockResolvedValue({
      ...IDENTITIES,
      identities: [{ ...IDENTITIES.identities[0], signature: "" }],
    });

    const { body } = await openReply();

    await waitFor(() => expect(body.value).toContain("just checking in"));
    await new Promise((r) => setTimeout(r, 50));
    // The body is exactly the quote block and nothing else - no stray blank
    // lines where a signature would have gone. (The attribution's time renders
    // in the runner's local zone, so match its shape, not a fixed hour.)
    expect(body.value).toMatch(
      /^\n\nOn Jun 3, 2026 at \d{1,2}:\d{2} [AP]M, Alice wrote:\njust checking in\nbody text$/,
    );
  });

  it("does not autosave a draft for a reply the user never touched", async () => {
    // The autosave is debounced 1500ms and only runs when `replyDirty`. Seeding
    // makes the mirror differ from the raw seed byte-for-byte (the editor drops
    // the "> " markers), so a raw comparison marks an untouched reply dirty and
    // silently saves a draft holding nothing but a quote and a sign-off.
    // Waiting past the real debounce is the point: a 50ms wait passes either way.
    const { body } = await openReply();
    await waitFor(() => expect(body.value).toContain(SIG));

    await new Promise((r) => setTimeout(r, 1800));

    expect(putDraft).not.toHaveBeenCalled();
  }, 10000);

  it("still autosaves once the user actually writes something", async () => {
    // The guard above must not have been bought by disabling autosave.
    const { body } = await openReply();
    await waitFor(() => expect(body.value).toContain(SIG));

    fireEvent.change(body, { target: { value: `thanks, will do!${body.value}` } });
    await waitFor(() => expect(putDraft).toHaveBeenCalled(), { timeout: 5000 });
  }, 10000);

  it("does not add a second signature when the reply is expanded to the dialog", async () => {
    // The handoff passes the LIVE inline body - signature already in it - as
    // `initial.text`. If that prefill still looks like a reply, the dialog
    // seeds again: two signatures, and setPlainText flattens the rich document
    // the inline composer had built.
    const { inline, body } = await openReply();
    await waitFor(() => expect(body.value).toContain(SIG));
    fireEvent.change(body, { target: { value: `Thanks!${body.value}` } });

    fireEvent.click(within(inline).getByRole("button", { name: "Open in full composer" }));

    const dialog = await screen.findByRole("dialog");
    const dialogBody = (await within(dialog).findByLabelText("Message")) as HTMLTextAreaElement;
    await new Promise((r) => setTimeout(r, 80));

    expect(dialogBody.value.split(SIG).length - 1).toBe(1);
    expect(dialogBody.value).toContain("Thanks!");
  });
});
describe("signature seeding once the editor is already mounted", () => {
  // Ordering matters more than anything else in this file. When identities
  // resolve BEFORE the lazy editor mounts, setPlainText never runs and the
  // mirror stays byte-identical to the raw seed - so every sameBody() call
  // compares a string with itself and the tests pass for the wrong reason.
  // Deferring identities past the mount is the only ordering that exercises
  // the round-trip, and it is the ordering a warm page actually has.
  function deferIdentities() {
    let release!: () => void;
    vi.mocked(getIdentities).mockReturnValue(
      new Promise((res) => {
        release = () => res(IDENTITIES);
      }),
    );
    return () => release();
  }

  const NESTED = {
    ...THREAD,
    messages: [
      {
        ...THREAD.messages[0],
        body: {
          text: "Sounds good.\n\n> On Jun 1, Sam wrote:\n> here is my question",
          html: "",
          attachments: [],
        },
      },
    ],
  };

  it("does not autosave a junk draft when the quote is NESTED", async () => {
    // The seed carries "> > here is my question"; the editor's blockquote
    // absorbs one level and returns "> here is my question". Stripping a single
    // level from each side left them unequal, so an untouched reply in any
    // ongoing conversation looked edited and saved a draft.
    vi.mocked(getThread).mockResolvedValue(NESTED);
    const release = deferIdentities();

    renderApp();
    fireEvent.click(await screen.findByText("Hello from Alice"));
    fireEvent.click(await screen.findByRole("button", { name: "Reply" }));
    const inline = await screen.findByTestId("inline-reply");
    const body = (await within(inline).findByLabelText("Message")) as HTMLTextAreaElement;

    release();
    await waitFor(() => expect(body.value).toContain(SIG));

    await new Promise((r) => setTimeout(r, 1800));
    expect(putDraft).not.toHaveBeenCalled();
  }, 10000);

  it("does not resurrect a quote the user deleted while identities were loading", async () => {
    const release = deferIdentities();

    renderApp();
    fireEvent.click(await screen.findByText("Hello from Alice"));
    fireEvent.click(await screen.findByRole("button", { name: "Reply" }));
    const inline = await screen.findByTestId("inline-reply");
    const body = (await within(inline).findByLabelText("Message")) as HTMLTextAreaElement;
    await waitFor(() => expect(body.value).toContain("just checking in"));

    // Deleting the quoted history is an ordinary thing to do.
    fireEvent.change(body, { target: { value: "" } });
    release();
    await new Promise((r) => setTimeout(r, 120));

    expect(body.value).not.toContain("just checking in");
  }, 10000);
});

describe("Draft with AI keeps the signature", () => {
  it("puts the AI draft above the signature, not instead of it", async () => {
    // The inline AI path rebuilt the body from the UNSIGNED prefill, so one
    // click silently dropped the sign-off and nothing put it back.
    const { inline, body } = await openReply();
    await waitFor(() => expect(body.value).toContain(SIG));

    fireEvent.click(within(inline).getByRole("button", { name: /draft with ai/i }));

    await waitFor(() => expect(body.value).toContain("AI DRAFT"), { timeout: 5000 });
    expect(body.value).toContain(SIG);
    expect(body.value.indexOf("AI DRAFT")).toBeLessThan(body.value.indexOf(SIG));
  }, 10000);
});
