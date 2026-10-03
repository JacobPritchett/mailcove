/**
 * Junk: the view, reporting and un-reporting, and blocking a sender.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "../App";
import MessageList from "../components/MessageList";
import BulkActionBar from "../components/BulkActionBar";
import Reader from "../components/Reader";
import FiltersDialog from "../components/FiltersDialog";
import { blockSenderOfThread, senderToBlock } from "../lib/blockSender";
import type { ThreadListRow, ThreadResponse } from "../lib/types";

vi.mock("../lib/api", () => {
  class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  return {
    ApiError,
    listThreads: vi.fn(),
    getCounts: vi.fn(),
    mutateThread: vi.fn(() => Promise.resolve({ ok: true })),
    mutateThreads: vi.fn(() => Promise.resolve({ ok: true, count: 0 })),
    getThread: vi.fn(),
    getMe: vi.fn(() => Promise.resolve({ email: "me@example.com" })),
    getIdentities: vi.fn(() => Promise.resolve({ identities: [], defaultLocal: "hello", defaultDomain: "example.com" })),
    attachmentUrl: vi.fn(),
    listFilters: vi.fn(() => Promise.resolve({ filters: [] })),
    listBlocked: vi.fn(() => Promise.resolve({ blocked: [] })),
    addBlocked: vi.fn((address: string) => Promise.resolve({ ok: true, address })),
    removeBlocked: vi.fn(() => Promise.resolve({ ok: true })),
  };
});
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), dismiss: vi.fn() }),
  Toaster: () => null,
}));

import { ApiError, listThreads, getCounts, getThread, mutateThread, listBlocked, addBlocked, removeBlocked } from "../lib/api";
import { toast } from "sonner";

const ROW: ThreadListRow = {
  thread_id: "t1", id: "m1", msg_from: "Offers <deals@shop.example>", msg_to: "me@example.com",
  subject: "You won", snippet: "claim now", date: Date.now(), count: 1, anyUnread: 1,
  hasAttachments: 0, starred: 0, category: null,
};
const THREAD: ThreadResponse = {
  thread_id: "t1",
  messages: [{
    id: "m1", thread_id: "t1", direction: "in", folder: "inbox",
    // The display name claims one address; the authenticated one is another.
    msg_from: "\"Your Bank <security@bank.example>\" <deals@shop.example>",
    from_addr: "deals@shop.example",
    msg_to: "me@example.com", subject: "You won", snippet: "claim now", date: Date.now(),
    unread: 0, has_attachments: 0, state: "inbox",
    body: { text: "claim now", html: "", attachments: [] },
  }],
};

function makeQc() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}
function withClient(ui: React.ReactNode, qc = makeQc()) {
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listThreads).mockResolvedValue({ threads: [ROW], unread: 1, user: "me" });
  vi.mocked(getCounts).mockResolvedValue({ inbox: 1, starred: 0, sent: 0, all: 1, trash: 0, spam: 0, inboxUnread: 1 });
  vi.mocked(getThread).mockResolvedValue(THREAD);
  vi.mocked(listBlocked).mockResolvedValue({ blocked: [] });
});

describe("Junk in the sidebar", () => {
  it("lists Junk with no count while it is empty", async () => {
    withClient(<App />);
    const junk = await screen.findByRole("button", { name: "Junk" });
    expect(junk).toBeInTheDocument();
  });

  it("shows a non-zero count as a plain number, not a badge", async () => {
    vi.mocked(getCounts).mockResolvedValue({ inbox: 1, starred: 0, sent: 0, all: 1, trash: 0, spam: 4, inboxUnread: 1 });
    withClient(<App />);
    const junk = await screen.findByRole("button", { name: /^Junk\s*4$/ });
    expect(within(junk).getByText("4")).not.toHaveAttribute("data-slot", "badge");
    // The inbox's unread count still is one, and it is the only one.
    const inbox = screen.getByRole("button", { name: /^Inbox/ });
    expect(within(inbox).getByText("1")).toHaveAttribute("data-slot", "badge");
    const all = screen.getByRole("button", { name: /^All Mail/ });
    expect(within(all).getByText("1")).not.toHaveAttribute("data-slot", "badge");
    expect(screen.getByRole("navigation").querySelectorAll('[data-slot="badge"]')).toHaveLength(1);
  });

  it("opens the Junk view with its 30-day note", async () => {
    withClient(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Junk" }));
    await waitFor(() => expect(listThreads).toHaveBeenCalledWith(expect.objectContaining({ view: "spam" })));
    expect(screen.getByRole("note")).toHaveTextContent("Mail in Junk is deleted after 30 days.");
  });
});

describe("reporting junk", () => {
  it("! reports the open thread, with Undo and an offer to block the sender", async () => {
    withClient(<App />);
    await screen.findByText("You won");
    fireEvent.keyDown(document, { key: "j" });
    fireEvent.keyDown(document, { key: "!" });

    await waitFor(() => expect(mutateThread).toHaveBeenCalledWith("t1", "spam"));
    const call = vi.mocked(toast).mock.calls.find(([label]) => label === "Moved to Junk");
    expect(call).toBeDefined();
    const opts = call![1] as unknown as {
      action: { label: string; onClick(): void };
      cancel: { label: string; onClick(): void };
    };
    expect(opts.action.label).toBe("Undo");
    expect(opts.cancel.label).toBe("Block this sender too");
    // Undo is the inverse action, after the original settled.
    opts.action.onClick();
    await waitFor(() => expect(mutateThread).toHaveBeenCalledWith("t1", "unspam"));
  });

  it("blocking from the toast uses the authenticated address and names it", async () => {
    withClient(<App />);
    await screen.findByText("You won");
    fireEvent.keyDown(document, { key: "j" });
    fireEvent.keyDown(document, { key: "!" });
    await waitFor(() => expect(mutateThread).toHaveBeenCalledWith("t1", "spam"));
    const opts = vi.mocked(toast).mock.calls.find(([label]) => label === "Moved to Junk")![1] as unknown as {
      cancel: { onClick(): void };
    };
    opts.cancel.onClick();
    await waitFor(() => expect(addBlocked).toHaveBeenCalledWith("deals@shop.example"));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Blocked deals@shop.example", expect.anything()));
  });

  it("blocking from the toast does not cost the Undo for the junk report", async () => {
    withClient(<App />);
    await screen.findByText("You won");
    fireEvent.keyDown(document, { key: "j" });
    fireEvent.keyDown(document, { key: "!" });
    await waitFor(() => expect(mutateThread).toHaveBeenCalledWith("t1", "spam"));
    const junkToasts = () => vi.mocked(toast).mock.calls.filter(([label]) => label === "Moved to Junk");
    type Opts = { id: string; action: { onClick(): void }; cancel?: { onClick(): void }; onDismiss(): void };
    const first = junkToasts()[0][1] as unknown as Opts;
    first.cancel!.onClick();
    // Sonner closes the toast its button belongs to.
    first.onDismiss();

    // It comes back, under a new id, with Undo and without the offer.
    await waitFor(() => expect(junkToasts()).toHaveLength(2));
    const second = junkToasts()[1][1] as unknown as Opts;
    expect(second.id).not.toBe(first.id);
    expect(second.cancel).toBeUndefined();
    // Both the button and `z` still undo the report.
    fireEvent.keyDown(document, { key: "z" });
    await waitFor(() => expect(mutateThread).toHaveBeenCalledWith("t1", "unspam"));
    await waitFor(() => expect(addBlocked).toHaveBeenCalledWith("deals@shop.example"));
  });

  it("a bulk report does not offer to block (there is no one sender)", async () => {
    vi.mocked(listThreads).mockResolvedValue({ threads: [ROW, { ...ROW, thread_id: "t2", subject: "Two" }], unread: 0, user: "me" });
    withClient(<App />);
    await screen.findByText("Two");
    fireEvent.keyDown(document, { key: "*" });
    fireEvent.keyDown(document, { key: "a" });
    fireEvent.keyDown(await screen.findByRole("button", { name: "More actions for the selection" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Report junk" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("2 moved to junk", expect.anything()));
    const opts = vi.mocked(toast).mock.calls.find(([label]) => label === "2 moved to junk")![1] as { cancel?: unknown };
    expect(opts.cancel).toBeUndefined();
  });

  it("a list row offers Report junk", async () => {
    const onAction = vi.fn();
    withClient(<MessageList view="inbox" selectedThreadId={null} onSelect={() => {}} onAction={onAction} />);
    fireEvent.keyDown(await screen.findByRole("button", { name: /^More actions/ }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Report junk" }));
    expect(onAction).toHaveBeenCalledWith(["t1"], "spam");
  });

  it("! does nothing in Junk or Trash", async () => {
    withClient(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Junk" }));
    await screen.findByText("You won");
    fireEvent.keyDown(document, { key: "j" });
    fireEvent.keyDown(document, { key: "!" });
    fireEvent.keyDown(document, { key: "e" });
    await new Promise((r) => setTimeout(r, 10));
    expect(mutateThread).not.toHaveBeenCalledWith("t1", "spam");
    expect(mutateThread).not.toHaveBeenCalledWith("t1", "archive");
  });
});

describe("the Junk view", () => {
  it("rows offer Not junk and Delete forever instead of Archive and Trash", async () => {
    const onAction = vi.fn();
    withClient(<MessageList view="spam" selectedThreadId={null} onSelect={() => {}} onAction={onAction} />);
    fireEvent.click(await screen.findByRole("button", { name: "Not junk" }));
    expect(onAction).toHaveBeenCalledWith(["t1"], "unspam");
    expect(screen.getByRole("button", { name: "Delete forever" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^More actions/ })).toBeNull();
  });

  it("the bulk bar offers Not junk and Delete forever", () => {
    const onAction = vi.fn();
    render(<BulkActionBar count={2} view="spam" onAction={onAction} onClear={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Mark selected as not junk" }));
    expect(onAction).toHaveBeenCalledWith("unspam");
    expect(screen.getByRole("button", { name: "Delete selected forever" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive selected" })).toBeNull();
  });

  it("the reader offers Not junk and Delete forever", async () => {
    const onAction = vi.fn();
    withClient(<Reader threadId="t1" view="spam" onAction={onAction} />);
    fireEvent.click(await screen.findByRole("button", { name: "Not junk" }));
    expect(onAction).toHaveBeenCalledWith("unspam");
    expect(screen.getByRole("button", { name: "Delete forever" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
  });
});

describe("blocking a sender", () => {
  it("picks the authenticated address of the latest inbound message", () => {
    expect(
      senderToBlock([
        { direction: "in", from_addr: "first@a.example" },
        { direction: "in", from_addr: "latest@b.example" },
        { direction: "out", from_addr: "me@example.com" },
      ]),
    ).toBe("latest@b.example");
    expect(senderToBlock([{ direction: "in", from_addr: null }])).toBeNull();
  });

  it("says so when there is no authenticated sender to block", async () => {
    vi.mocked(getThread).mockResolvedValue({
      thread_id: "t1",
      messages: [{ ...THREAD.messages[0], from_addr: null }],
    });
    await blockSenderOfThread(makeQc(), "t1");
    expect(addBlocked).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("Couldn't find a sender to block.");
  });

  const FAILED_AUTH: ThreadResponse = {
    thread_id: "t1",
    messages: [{
      ...THREAD.messages[0],
      body: { ...THREAD.messages[0].body, headers: { auth: { spf: "fail", dkim: "none", dmarc: "fail" } } },
    }],
  };
  const WARNING = "This message did not pass the sender check, so it may not really be from deals@shop.example.";

  it("from the toast, a message that failed the sender check is not blocked without a second step", async () => {
    vi.mocked(getThread).mockResolvedValue(FAILED_AUTH);
    await blockSenderOfThread(makeQc(), "t1");
    expect(addBlocked).not.toHaveBeenCalled();
    const call = vi.mocked(toast).mock.calls.find(([label]) => label === WARNING);
    expect(call).toBeDefined();
    const opts = call![1] as unknown as { action: { label: string; onClick(): void } };
    expect(opts.action.label).toBe("Block anyway");
    opts.action.onClick();
    await waitFor(() => expect(addBlocked).toHaveBeenCalledWith("deals@shop.example"));
  });

  it("the confirm says so too when the message failed the sender check", async () => {
    vi.mocked(getThread).mockResolvedValue(FAILED_AUTH);
    withClient(<Reader threadId="t1" view="inbox" onAction={() => {}} />);
    fireEvent.keyDown(await screen.findByRole("button", { name: "Message actions" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Block sender" }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent(WARNING);
  });

  it("and says nothing of the kind for mail that passed", async () => {
    withClient(<Reader threadId="t1" view="inbox" onAction={() => {}} />);
    fireEvent.keyDown(await screen.findByRole("button", { name: "Message actions" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Block sender" }));
    expect(await screen.findByRole("alertdialog")).not.toHaveTextContent("sender check");
  });

  it("the message menu blocks after a confirm that names the address", async () => {
    withClient(<Reader threadId="t1" view="inbox" onAction={() => {}} />);
    fireEvent.keyDown(await screen.findByRole("button", { name: "Message actions" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Block sender" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Block deals@shop.example?")).toBeInTheDocument();
    expect(addBlocked).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Block sender" }));
    await waitFor(() => expect(addBlocked).toHaveBeenCalledWith("deals@shop.example"));
  });

  it("passes on the Worker's reason when a block is refused", async () => {
    vi.mocked(addBlocked).mockRejectedValueOnce(new ApiError(400, "that is one of your own domains"));
    await blockSenderOfThread(makeQc(), "t1");
    expect(toast.error).toHaveBeenCalledWith("Couldn't block deals@shop.example: that is one of your own domains.");
  });
});

describe("blocked senders in Rules", () => {
  it("lists entries, describing a domain entry in words", async () => {
    vi.mocked(listBlocked).mockResolvedValue({
      blocked: [{ address: "pest@spam.example", created: 2 }, { address: "@ads.example", created: 1 }],
    });
    withClient(<FiltersDialog open onOpenChange={() => {}} />);
    expect(await screen.findByText("pest@spam.example")).toBeInTheDocument();
    expect(screen.getByText("Everyone at ads.example")).toBeInTheDocument();
  });

  it("says when nobody is blocked", async () => {
    withClient(<FiltersDialog open onOpenChange={() => {}} />);
    expect(await screen.findByText("Nobody is blocked.")).toBeInTheDocument();
  });

  it("adds an entry and clears the field", async () => {
    withClient(<FiltersDialog open onOpenChange={() => {}} />);
    const input = await screen.findByLabelText("Address or domain to block");
    fireEvent.change(input, { target: { value: "  @Ads.Example " } });
    fireEvent.click(screen.getByRole("button", { name: "Block" }));
    await waitFor(() => expect(addBlocked).toHaveBeenCalledWith("@Ads.Example"));
    await waitFor(() => expect(input).toHaveValue(""));
    // The list is refetched to show it.
    await waitFor(() => expect(vi.mocked(listBlocked).mock.calls.length).toBeGreaterThan(1));
  });

  it("shows the Worker's validation message under the field, tied to it", async () => {
    vi.mocked(addBlocked).mockRejectedValueOnce(new ApiError(400, "that is one of your own domains"));
    withClient(<FiltersDialog open onOpenChange={() => {}} />);
    const input = await screen.findByLabelText("Address or domain to block");
    fireEvent.change(input, { target: { value: "@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Block" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("That is one of your own domains.");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAttribute("aria-describedby", alert.id);
    // The rejected text stays so it can be corrected; editing clears the error.
    expect(input).toHaveValue("@example.com");
    fireEvent.change(input, { target: { value: "@example.co" } });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("removes an entry", async () => {
    vi.mocked(listBlocked).mockResolvedValue({ blocked: [{ address: "pest@spam.example", created: 2 }] });
    withClient(<FiltersDialog open onOpenChange={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Unblock pest@spam.example" }));
    await waitFor(() => expect(removeBlocked).toHaveBeenCalledWith("pest@spam.example"));
  });
});
