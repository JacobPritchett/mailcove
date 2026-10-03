// Reader behaviour that only shows up over time: a refetch failing under an
// open thread, re-reading a thread that was marked unread, and attachments
// that share a name.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Reader from "../components/Reader";
import ChatView from "../components/ChatView";
import type { ThreadResponse, ThreadMessage } from "../lib/types";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ApiError: actual.ApiError,
    attachmentUrl: actual.attachmentUrl,
    listThreads: vi.fn(),
    getCounts: vi.fn(),
    mutateThread: vi.fn(() => Promise.resolve({ ok: true })),
    mutateThreads: vi.fn(() => Promise.resolve({ ok: true, count: 0 })),
    getMe: vi.fn(),
    getIdentities: vi.fn(() =>
      Promise.resolve({ identities: [], defaultLocal: "hello", defaultDomain: "example.com" }),
    ),
    send: vi.fn(),
    getThread: vi.fn(),
    putDraft: vi.fn(() => Promise.resolve({ ok: true })),
    deleteDraft: vi.fn(() => Promise.resolve({ ok: true })),
    showMessageImages: vi.fn(),
    allowImagesFrom: vi.fn(),
  };
});
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  Toaster: () => null,
}));

import { toast } from "sonner";
import { getThread, mutateThread, allowImagesFrom } from "../lib/api";

function message(id: string, threadId: string, over: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id, thread_id: threadId, direction: "in", folder: "inbox",
    msg_from: "Alice <alice@example.com>", msg_to: "me@example.com", subject: `Subj ${threadId}`,
    snippet: "hi", date: Date.now(), unread: 0, has_attachments: 0, starred: 0,
    body: { text: "body text", html: "", attachments: [] },
    ...over,
  } as ThreadMessage;
}
const thread = (id: string, unread: 0 | 1 = 0, count = 1): ThreadResponse => ({
  thread_id: id,
  messages: Array.from({ length: count }, (_, i) => message(`${id}-m${i}`, id, { unread })),
});

function setup(initialThreadId: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Harness({ threadId }: { threadId: string }) {
    return (
      <QueryClientProvider client={qc}>
        <Reader threadId={threadId} replyOpen onReplyOpenChange={vi.fn()} onAction={vi.fn()} />
      </QueryClientProvider>
    );
  }
  const view = render(<Harness threadId={initialThreadId} />);
  return { qc, open: (id: string) => view.rerender(<Harness threadId={id} />) };
}

const readCalls = () => vi.mocked(mutateThread).mock.calls.filter((c) => c[1] === "read").map((c) => c[0]);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("a failed background refetch", () => {
  it("keeps the conversation and an in-progress reply on screen, with a retry notice", async () => {
    vi.mocked(getThread).mockResolvedValue(thread("t1"));
    const { qc } = setup("t1");
    await screen.findByRole("heading", { name: "Subj t1" });
    const reply = await screen.findByLabelText("Message");
    fireEvent.change(reply, { target: { value: "half written" } });

    vi.mocked(getThread).mockRejectedValue(new Error("network error"));
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ["thread"] });
    });

    expect(await screen.findByText(/Couldn't refresh/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Subj t1" })).toBeInTheDocument();
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("half written");
    expect(screen.queryByText(/load this conversation/)).not.toBeInTheDocument();

    // Retry recovers and the notice goes away, still without losing the reply.
    vi.mocked(getThread).mockResolvedValue(thread("t1"));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByText(/Couldn't refresh/)).not.toBeInTheDocument());
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("half written");
  });

  it("still shows the full error screen when there is nothing to show", async () => {
    vi.mocked(getThread).mockRejectedValue(new Error("nope"));
    setup("t1");
    expect(await screen.findByText(/load this conversation/)).toBeInTheDocument();
  });
});

describe("marking read", () => {
  it("marks a thread read again when it is reopened after being marked unread", async () => {
    vi.mocked(getThread).mockImplementation(async (id) => thread(id, id === "t1" ? 1 : 0));
    const { open } = setup("t1");
    await waitFor(() => expect(readCalls()).toEqual(["t1"]));

    open("t2");
    await screen.findByRole("heading", { name: "Subj t2" });
    open("t1");
    await screen.findByRole("heading", { name: "Subj t1" });
    await waitFor(() => expect(readCalls()).toEqual(["t1", "t1"]));
  });

  it("marks read again when a new unread message arrives in the open thread", async () => {
    vi.mocked(getThread).mockResolvedValue(thread("t1", 1, 1));
    const { qc } = setup("t1");
    await waitFor(() => expect(readCalls()).toEqual(["t1"]));

    vi.mocked(getThread).mockResolvedValue(thread("t1", 1, 2));
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ["thread"] });
    });
    await screen.findByText("2 messages");
    await waitFor(() => expect(readCalls()).toEqual(["t1", "t1"]));
  });

  it("does not immediately undo Mark unread on the thread that is still open", async () => {
    vi.mocked(getThread).mockResolvedValue(thread("t1", 1));
    const { qc } = setup("t1");
    await waitFor(() => expect(readCalls()).toEqual(["t1"]));
    // The user marks it unread; the refetch brings back unread = 1.
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ["thread"] });
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(readCalls()).toEqual(["t1"]);
  });
});

describe("attachments", () => {
  const twoSameName = thread("t1");
  twoSameName.messages[0].body.attachments = [
    { name: "invoice.pdf", mimeType: "application/pdf", size: 1, partId: "2" },
    { name: "invoice.pdf", mimeType: "application/pdf", size: 2, partId: "3" },
    { name: "huge.bin", mimeType: "application/octet-stream", size: 9, partId: "4", stored: false },
  ];

  it("links two same-named files to their own parts", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(getThread).mockResolvedValue(twoSameName);
    setup("t1");
    await screen.findByRole("heading", { name: "Subj t1" });
    const links = screen.getAllByRole("link", { name: /invoice\.pdf/ });
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/api/attachments/t1-m0/invoice.pdf?part=2",
      "/api/attachments/t1-m0/invoice.pdf?part=3",
    ]);
    // No duplicate-key warning from React.
    expect(error.mock.calls.flat().join(" ")).not.toMatch(/same key/);
    error.mockRestore();
  });

  it("chat view links by part and shows files that were not stored as plain text", () => {
    render(<ChatView data={twoSameName} />);
    const links = screen.getAllByRole("link", { name: /invoice\.pdf/ });
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/api/attachments/t1-m0/invoice.pdf?part=2",
      "/api/attachments/t1-m0/invoice.pdf?part=3",
    ]);
    expect(screen.queryByRole("link", { name: /huge\.bin/ })).not.toBeInTheDocument();
    expect(screen.getByText("huge.bin")).toBeInTheDocument();
    expect(screen.getByText("(not stored)")).toBeInTheDocument();
  });

  it("chat view does the same in a multi-message thread", () => {
    const multi = thread("t1", 0, 2);
    multi.messages[1].body.attachments = twoSameName.messages[0].body.attachments;
    render(<ChatView data={multi} />);
    expect(screen.getAllByRole("link", { name: /invoice\.pdf/ })).toHaveLength(2);
    expect(screen.queryByRole("link", { name: /huge\.bin/ })).not.toBeInTheDocument();
    expect(screen.getByText("(not stored)")).toBeInTheDocument();
  });
});

describe("reader chrome", () => {
  it("describes Chat as a layout, not an AI feature", async () => {
    vi.mocked(getThread).mockResolvedValue(thread("t1"));
    setup("t1");
    fireEvent.keyDown(await screen.findByRole("button", { name: "More actions" }), { key: "Enter" });
    const chat = await screen.findByRole("menuitemradio", { name: "Chat" });
    expect(chat.getAttribute("title")).not.toMatch(/AI/);
    expect(chat.getAttribute("title")).toMatch(/chat bubbles/i);
  });

  it("uses the hardened sandbox on the message iframe", async () => {
    const t = thread("t1");
    t.messages[0].body.html = "<p>hello</p>";
    vi.mocked(getThread).mockResolvedValue(t);
    setup("t1");
    const frame = await screen.findByTitle(/Message from/);
    // No scripts and no popups: links are opened by the parent instead.
    expect(frame.getAttribute("sandbox")).toBe("allow-same-origin");
    expect(frame.getAttribute("srcdoc")).toContain(`<base target="_blank">`);
    expect(frame.getAttribute("srcdoc")).toContain("default-src 'none'");
  });

  it("says so when Always show images fails", async () => {
    const t = thread("t1");
    t.messages[0].body.html = "<p>hello</p>";
    t.messages[0].remoteImageCount = 2;
    vi.mocked(getThread).mockResolvedValue(t);
    vi.mocked(allowImagesFrom).mockRejectedValue(new Error("nope"));
    setup("t1");
    fireEvent.click(await screen.findByRole("button", { name: /Always show from/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
  });
});
