// Long conversations in the reader: earlier messages fold to one line, and
// nothing of a folded message's body is mounted.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Reader from "../components/Reader";
import type { ComposeInitial } from "../components/ComposeDialog";
import type { ReplyMode } from "../lib/conversation";
import type { ThreadMessage } from "../lib/types";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ApiError: actual.ApiError,
    attachmentUrl: actual.attachmentUrl,
    mutateThread: vi.fn(() => Promise.resolve({ ok: true })),
    getIdentities: vi.fn(() =>
      Promise.resolve({ identities: [], defaultLocal: "hello", defaultDomain: "example.com" }),
    ),
    send: vi.fn(() => Promise.resolve({ ok: true, id: "sent-1" })),
    getThread: vi.fn(),
    putDraft: vi.fn(() => Promise.resolve({ ok: true })),
    deleteDraft: vi.fn(() => Promise.resolve({ ok: true })),
    showMessageImages: vi.fn(),
    allowImagesFrom: vi.fn(),
    unsubscribeFrom: vi.fn(),
  };
});
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  Toaster: () => null,
}));

import { getThread } from "../lib/api";

function message(n: number, over: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id: `m${n}`, thread_id: "t1", direction: "in", folder: "inbox",
    msg_from: `Sender ${n} <s${n}@example.com>`, from_addr: `s${n}@example.com`,
    msg_to: "me@example.com", msg_cc: null,
    subject: "Planning", snippet: `Snippet ${n}`, date: Date.UTC(2026, 9, 1, n), unread: 0, has_attachments: 0,
    starred: 0, domain: "example.com", envelope_to: "me@example.com", message_id: `<m${n}@example.com>`,
    body: { text: "", html: `<p>Body ${n}</p>`, attachments: [] },
    ...over,
  } as ThreadMessage;
}
const thread = (n: number, over: Record<number, Partial<ThreadMessage>> = {}) =>
  Array.from({ length: n }, (_, i) => message(i + 1, over[i + 1]));

function setup(messages: ThreadMessage[]) {
  vi.mocked(getThread).mockResolvedValue({ thread_id: "t1", messages });
  const onOpenCompose = vi.fn<(i: ComposeInitial) => void>();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Harness() {
    const [open, setOpen] = useState(false);
    const [mode, setMode] = useState<ReplyMode>("reply");
    return (
      <QueryClientProvider client={qc}>
        <Reader
          threadId="t1"
          replyOpen={open}
          onReplyOpenChange={setOpen}
          replyMode={mode}
          onReplyRequest={(m) => {
            setMode(m);
            setOpen(true);
          }}
          onOpenCompose={onOpenCompose}
          onAction={vi.fn()}
        />
      </QueryClientProvider>
    );
  }
  render(<Harness />);
  return { onOpenCompose, qc };
}

const frames = () => Array.from(document.querySelectorAll("iframe")).map((f) => f.title);
const folded = () => screen.queryAllByRole("button", { name: /^Expand message from/ });

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe("a long conversation", () => {
  it("opens with the last message and folds the earlier ones to a line each", async () => {
    setup(thread(5));
    await screen.findByText("5 messages");
    expect(folded()).toHaveLength(4);
    expect(frames()).toEqual(["Message from Sender 5 <s5@example.com>"]);
    // The line says who, what and (via RelativeTime) when.
    const line = screen.getByRole("button", { name: "Expand message from Sender 2" });
    expect(within(line).getByText("Sender 2")).toBeInTheDocument();
    expect(within(line).getByText("Snippet 2")).toBeInTheDocument();
    expect(line.querySelector("time")).not.toBeNull();
    expect(line).toHaveAttribute("aria-expanded", "false");
  });

  it("leaves a conversation of three or fewer alone", async () => {
    setup(thread(3));
    await screen.findByText("3 messages");
    expect(folded()).toHaveLength(0);
    expect(frames()).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "Expand all" })).toBeNull();
  });

  it("keeps unread messages open as well as the last", async () => {
    setup(thread(6, { 3: { unread: 1 }, 4: { unread: 1 } }));
    await screen.findByText("6 messages");
    expect(frames()).toEqual([
      "Message from Sender 3 <s3@example.com>",
      "Message from Sender 4 <s4@example.com>",
      "Message from Sender 6 <s6@example.com>",
    ]);
    expect(folded()).toHaveLength(3);
  });

  it("does not fold them away again once opening the thread has marked it read", async () => {
    const { qc } = setup(thread(5, { 2: { unread: 1 } }));
    await screen.findByText("5 messages");
    expect(frames()).toHaveLength(2);
    // The refetch after read-marking: nothing is unread any more.
    vi.mocked(getThread).mockResolvedValue({ thread_id: "t1", messages: thread(5) });
    await qc.invalidateQueries({ queryKey: ["thread"] });
    await waitFor(() => expect(getThread).toHaveBeenCalledTimes(2));
    expect(frames()).toHaveLength(2);
  });

  it("unfolds a message when its line is pressed, and moves focus to it", async () => {
    setup(thread(5));
    await screen.findByText("5 messages");
    fireEvent.click(screen.getByRole("button", { name: "Expand message from Sender 2" }));
    expect(frames()).toEqual(["Message from Sender 2 <s2@example.com>", "Message from Sender 5 <s5@example.com>"]);
    expect(folded()).toHaveLength(3);
    expect(document.activeElement).toBe(screen.getByRole("region", { name: "Message from Sender 2" }));
  });

  it("Expand all unfolds everything, and Collapse earlier goes back to the last message", async () => {
    setup(thread(5));
    await screen.findByText("5 messages");
    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    expect(folded()).toHaveLength(0);
    expect(frames()).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: "Collapse earlier" }));
    expect(folded()).toHaveLength(4);
    expect(frames()).toEqual(["Message from Sender 5 <s5@example.com>"]);
  });

  it("shows mail that arrives while the conversation is open, without folding what was open", async () => {
    const { qc } = setup(thread(4));
    await screen.findByText("4 messages");
    fireEvent.click(screen.getByRole("button", { name: "Expand message from Sender 1" }));
    vi.mocked(getThread).mockResolvedValue({ thread_id: "t1", messages: thread(5) });
    await qc.invalidateQueries({ queryKey: ["thread"] });
    await screen.findByText("5 messages");
    expect(frames()).toEqual([
      "Message from Sender 1 <s1@example.com>",
      "Message from Sender 4 <s4@example.com>",
      "Message from Sender 5 <s5@example.com>",
    ]);
  });

  it("does not start folding a short conversation that grows past three while open", async () => {
    const { qc } = setup(thread(3));
    await screen.findByText("3 messages");
    vi.mocked(getThread).mockResolvedValue({ thread_id: "t1", messages: thread(4) });
    await qc.invalidateQueries({ queryKey: ["thread"] });
    await screen.findByText("4 messages");
    expect(folded()).toHaveLength(0);
    expect(frames()).toHaveLength(4);
  });

  it("marks a folded message that has files or failed its sender check", async () => {
    setup(
      thread(5, {
        1: { body: { text: "", html: "<p>x</p>", attachments: [{ name: "a.pdf", mimeType: "application/pdf", size: 1, partId: "p0" }] } },
        2: { body: { text: "", html: "<p>x</p>", attachments: [], headers: { auth: { spf: "fail", dkim: "fail", dmarc: "fail" } } } },
      } as never),
    );
    await screen.findByText("5 messages");
    expect(within(screen.getByRole("button", { name: "Expand message from Sender 1" })).getByLabelText("1 attachment")).toBeInTheDocument();
    expect(within(screen.getByRole("button", { name: "Expand message from Sender 2" })).getByLabelText("Sender warning")).toBeInTheDocument();
    // Unfolded, the warning and the file are there in full.
    fireEvent.click(screen.getByRole("button", { name: "Expand message from Sender 2" }));
    expect(screen.getByRole("note", { name: "Sender warning" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expand message from Sender 1" }));
    expect(screen.getByRole("link", { name: /a\.pdf/ })).toBeInTheDocument();
  });

  it("an unfolded earlier message can be replied to from its own menu", async () => {
    setup(thread(5));
    await screen.findByText("5 messages");
    fireEvent.click(screen.getByRole("button", { name: "Expand message from Sender 2" }));
    const entry = screen.getByRole("region", { name: "Message from Sender 2" });
    fireEvent.pointerDown(within(entry).getByRole("button", { name: "Message actions" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Reply" }));
    expect(await screen.findByText(/Replying to/)).toHaveTextContent("s2@example.com");
  });

  it("the reply box still answers the latest message while earlier ones are folded", async () => {
    setup(thread(5));
    await screen.findByText("5 messages");
    expect(screen.getByTestId("inline-reply")).toHaveTextContent("Reply to s5@example.com");
  });

  it("chat mode is not folded", async () => {
    localStorage.setItem("reader.viewMode", "chat");
    setup(thread(5));
    await screen.findByText("5 messages");
    expect(folded()).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Expand all" })).toBeNull();
  });
});
