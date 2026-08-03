import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ComposeDialog, { type ComposeInitial } from "../components/ComposeDialog";

// Mock the api client. draftReply is the assertion target; send is present so
// useSend resolves.
vi.mock("../lib/api", () => ({
  ApiError: class ApiError extends Error {},
  send: vi.fn(),
  putDraft: vi.fn(() => Promise.resolve({ ok: true })),
  deleteDraft: vi.fn(() => Promise.resolve({ ok: true })),
  listDrafts: vi.fn(() => Promise.resolve({ drafts: [] })),
  getDraft: vi.fn(),
  draftReply: vi.fn(),
  getIdentities: vi.fn(() => Promise.resolve({ identities: [], defaultLocal: "hello", defaultDomain: "example.com" })),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() }, Toaster: () => null }));

import { draftReply } from "../lib/api";

function renderDialog(initial?: ComposeInitial) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ComposeDialog open onOpenChange={() => {}} initial={initial} />
    </QueryClientProvider>,
  );
}

const QUOTE = "\n\n----- On Mon, Alice wrote -----\n> the original message";

const REPLY_INITIAL: ComposeInitial = {
  to: "alice@example.com",
  subject: "Re: Lunch",
  text: QUOTE,
  replyQuote: QUOTE,
  inReplyTo: "<m1@example.com>",
  threadId: "t1",
};

/**
 * What the inline composer hands over when it is expanded: `text` is the LIVE
 * body - the user's words, their signature and the quote - while `replyQuote`
 * is still just the quote.
 */
const HANDED_OFF: ComposeInitial = {
  ...REPLY_INITIAL,
  text: `My own words.\n\nSam Rivera${QUOTE}`,
  signatureApplied: true,
};

beforeEach(() => vi.clearAllMocks());

describe("ComposeDialog — Draft with AI", () => {
  it("is hidden for a blank (non-reply) compose", () => {
    renderDialog(undefined);
    expect(screen.queryByRole("button", { name: /draft with ai/i })).toBeNull();
  });

  it("is shown for a reply (has threadId)", () => {
    renderDialog(REPLY_INITIAL);
    expect(screen.getByRole("button", { name: /draft with ai/i })).toBeInTheDocument();
  });

  it("fills the body with the AI draft above the preserved quote, drafting from the threadId", async () => {
    vi.mocked(draftReply).mockResolvedValue({ ok: true, draft: "Sounds great — see you at noon." });
    renderDialog(REPLY_INITIAL);

    fireEvent.click(screen.getByRole("button", { name: /draft with ai/i }));

    await waitFor(() => expect(draftReply).toHaveBeenCalledWith("t1"));
    const body = (await screen.findByLabelText("Message")) as HTMLTextAreaElement;
    await waitFor(() => expect(body.value).toContain("Sounds great — see you at noon."));
    // The quoted original is kept below the draft.
    // The mirror holds the editor's TEXT: "> " lines became a <blockquote>,
    // so the markers are gone. The quoted CONTENT is what survives.
    expect(body.value).toContain("the original message");
    // Draft comes first.
    expect(body.value.indexOf("Sounds great")).toBeLessThan(body.value.indexOf("the original"));
  });

  it("does not stack the user's own words under the AI draft after a handoff", async () => {
    // `initial.text` is the whole live body once a reply has been expanded from
    // the inline composer, so treating it as "the quote" put the user's typed
    // reply and their signature back underneath the AI draft.
    vi.mocked(draftReply).mockResolvedValue({ ok: true, draft: "AI DRAFT." });
    renderDialog(HANDED_OFF);

    fireEvent.click(screen.getByRole("button", { name: /draft with ai/i }));
    const body = (await screen.findByLabelText("Message")) as HTMLTextAreaElement;
    await waitFor(() => expect(body.value).toContain("AI DRAFT."));

    expect(body.value).not.toContain("My own words.");
    expect(body.value).toContain("the original message");
  });

  it("re-drafting does not stack the quote (uses the original quote, not the current body)", async () => {
    vi.mocked(draftReply)
      .mockResolvedValueOnce({ ok: true, draft: "First draft." })
      .mockResolvedValueOnce({ ok: true, draft: "Second draft." });
    renderDialog(REPLY_INITIAL);
    const btn = screen.getByRole("button", { name: /draft with ai/i });

    fireEvent.click(btn);
    const body = (await screen.findByLabelText("Message")) as HTMLTextAreaElement;
    await waitFor(() => expect(body.value).toContain("First draft."));

    fireEvent.click(btn);
    await waitFor(() => expect(body.value).toContain("Second draft."));
    expect(body.value).not.toContain("First draft.");
    // Exactly one copy of the quote.
    expect(body.value.split("the original message").length - 1).toBe(1);
  });
});
