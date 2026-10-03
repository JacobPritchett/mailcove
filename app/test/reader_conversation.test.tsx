// Reply all, forward, unsubscribe and the sender warnings, in the reader.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Reader from "../components/Reader";
import type { ComposeInitial } from "../components/ComposeDialog";
import type { ReplyMode } from "../lib/conversation";
import type { ThreadResponse, ThreadMessage } from "../lib/types";

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

import { toast } from "sonner";
import { getThread, send, unsubscribeFrom } from "../lib/api";

function message(over: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id: "m1", thread_id: "t1", direction: "in", folder: "inbox",
    msg_from: "Maya Okafor <maya@okafor.example>", from_addr: "maya@okafor.example",
    msg_to: "dev@patel.example", msg_cc: "shop@example.com, anna@lindqvist.example",
    subject: "Cabin weekend", snippet: "hi", date: Date.UTC(2026, 9, 2), unread: 0, has_attachments: 0, starred: 0,
    domain: "example.com", envelope_to: "shop@example.com", message_id: "<m1@okafor.example>",
    body: { text: "Yes or no?", html: "", attachments: [] },
    ...over,
  } as ThreadMessage;
}

function setup(messages: ThreadMessage[], extra: Partial<ThreadResponse> = {}) {
  vi.mocked(getThread).mockResolvedValue({ thread_id: "t1", messages, ...extra });
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
  return { onOpenCompose };
}

const toolbar = (name: string) => screen.getAllByRole("button", { name })[0];

beforeEach(() => vi.clearAllMocks());

describe("reply and reply all", () => {
  it("sends a plain reply to the sender only, from the address the mail was sent to", async () => {
    setup([message()]);
    fireEvent.click(await screen.findByRole("button", { name: "Reply" }));
    fireEvent.change(await screen.findByLabelText("Message"), { target: { value: "I am in" } });
    fireEvent.click(screen.getByRole("button", { name: /^send/i }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const p = vi.mocked(send).mock.calls[0][0];
    expect(p.to).toBe("maya@okafor.example");
    expect("cc" in p).toBe(false);
    expect(p.from).toBe("shop@example.com");
    expect(p.inReplyTo).toBe("<m1@okafor.example>");
  });

  it("reply all copies everyone else and leaves my own address out", async () => {
    setup([message()]);
    await screen.findByRole("heading", { name: "Cabin weekend" });
    fireEvent.click(toolbar("Reply all"));
    fireEvent.change(await screen.findByLabelText("Message"), { target: { value: "I am in" } });
    fireEvent.click(screen.getByRole("button", { name: /^send/i }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const p = vi.mocked(send).mock.calls[0][0];
    expect(p.to).toBe("maya@okafor.example");
    expect(p.cc).toEqual(["dev@patel.example", "anna@lindqvist.example"]);
  });

  it("does not offer reply all when it would reach nobody new", async () => {
    setup([message({ msg_to: "shop@example.com", msg_cc: null })]);
    await screen.findByRole("button", { name: "Reply" });
    expect(screen.queryByRole("button", { name: "Reply all" })).toBeNull();
  });

  it("replies to Reply-To when the sender set one", async () => {
    setup([message({ body: { text: "x", html: "", attachments: [], headers: { replyTo: [{ name: "", address: "list@group.example" }] } } })]);
    fireEvent.click(await screen.findByRole("button", { name: "Reply" }));
    expect(await screen.findByText("list@group.example")).toBeTruthy();
  });

  it("offers a follow-up on a thread that holds only my own sent mail", async () => {
    setup([message({ direction: "out", msg_from: "hello@example.com", msg_to: "maya@okafor.example", msg_cc: null, envelope_to: null })]);
    fireEvent.click(await screen.findByRole("button", { name: "Reply" }));
    const composer = await screen.findByTestId("inline-reply");
    expect(composer.textContent).toContain("Replying to maya@okafor.example as hello@example.com");
  });
});

describe("forward", () => {
  it("opens the composer with the original text and its stored files", async () => {
    const { onOpenCompose } = setup([
      message({
        body: {
          text: "Lease attached.", html: '<img src="cid:logo1">',
          attachments: [
            { partId: "p0", name: "lease.pdf", mimeType: "application/pdf", size: 10 },
            { partId: "p1", name: "logo.png", mimeType: "image/png", size: 5, contentId: "logo1", disposition: "inline" },
            { partId: "p2", name: "big.zip", mimeType: "application/zip", size: 5, stored: false },
            // A real attachment that carries a Content-ID, as Outlook's do.
            { partId: "p3", name: "contract.pdf", mimeType: "application/pdf", size: 7, contentId: "f_1", disposition: "attachment" },
          ],
        },
      }),
    ]);
    await screen.findByRole("heading", { name: "Cabin weekend" });
    fireEvent.click(toolbar("Forward"));
    const initial = onOpenCompose.mock.calls[0][0];
    expect(initial.subject).toBe("Fwd: Cabin weekend");
    expect(initial.to).toBeUndefined();
    expect(initial.inReplyTo).toBeUndefined();
    expect(initial.threadId).toBeUndefined();
    expect(initial.text).toContain("---------- Forwarded message ----------");
    expect(initial.text).toContain("Lease attached.");
    expect(initial.generated).toBe(true);
    // The image the body shows is part of the body; the unstored file has no
    // bytes and is named so the dialog can say so; everything else travels.
    expect(initial.forward).toEqual({
      messageId: "m1",
      parts: [
        { partId: "p0", name: "lease.pdf", type: "application/pdf", size: 10 },
        { partId: "p3", name: "contract.pdf", type: "application/pdf", size: 7 },
      ],
      notStored: ["big.zip"],
    });
  });
});

describe("mailing lists", () => {
  const listed = (unsubscribe: object) =>
    message({ body: { text: "news", html: "", attachments: [], headers: { unsubscribe } as never } });

  it("unsubscribes through the server and says so", async () => {
    vi.mocked(unsubscribeFrom).mockResolvedValue({ ok: true, method: "one-click" });
    setup([listed({ url: "https://news.example/u", oneClick: true })]);
    fireEvent.click(await screen.findByRole("button", { name: "Unsubscribe" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Unsubscribed"));
    expect(unsubscribeFrom).toHaveBeenCalledWith("m1");
    expect(screen.getByRole("button", { name: "Unsubscribed" })).toHaveProperty("disabled", true);
  });

  it("when the list only offers a page, shows a real link to it and never opens a tab from code", async () => {
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    setup([listed({ url: "https://news.example/prefs", oneClick: false })]);
    const link = await screen.findByRole("link", { name: "Open the unsubscribe page" });
    expect(link).toHaveAttribute("href", "https://news.example/prefs");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.queryByRole("button", { name: "Unsubscribe" })).toBeNull();
    expect(unsubscribeFrom).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it("turns into that link when the Worker tried and was sent to a page", async () => {
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    vi.mocked(unsubscribeFrom).mockResolvedValue({ ok: true, method: "open", url: "https://news.example/confirm" });
    setup([listed({ url: "https://news.example/u", oneClick: true })]);
    fireEvent.click(await screen.findByRole("button", { name: "Unsubscribe" }));
    const link = await screen.findByRole("link", { name: "Open the unsubscribe page" });
    expect(link).toHaveAttribute("href", "https://news.example/confirm");
    expect(openSpy).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it("goes through the Worker when the list also takes a request by mail", async () => {
    vi.mocked(unsubscribeFrom).mockResolvedValue({ ok: true, method: "mailto" });
    setup([listed({ url: "https://news.example/prefs", oneClick: false, mailto: { address: "leave@news.example", subject: "unsubscribe" } })]);
    fireEvent.click(await screen.findByRole("button", { name: "Unsubscribe" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Unsubscribe request sent"));
  });

  it("never links to a page that is not https", async () => {
    setup([listed({ url: "http://news.example/prefs", oneClick: false })]);
    expect(await screen.findByRole("button", { name: "Unsubscribe" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open the unsubscribe page" })).toBeNull();
    vi.mocked(unsubscribeFrom).mockResolvedValue({ ok: true, method: "open", url: "javascript:alert(1)" });
    fireEvent.click(screen.getByRole("button", { name: "Unsubscribe" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(screen.queryByRole("link", { name: "Open the unsubscribe page" })).toBeNull();
  });

  it("says why when the Worker could not do it", async () => {
    const { ApiError } = await import("../lib/api");
    vi.mocked(unsubscribeFrom).mockRejectedValue(new ApiError(502, "the list refused the request (500)"));
    setup([listed({ url: "https://news.example/u", oneClick: true })]);
    fireEvent.click(await screen.findByRole("button", { name: "Unsubscribe" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't unsubscribe. The list refused the request (500)."),
    );
  });

  it("reports a failure and stays available", async () => {
    vi.mocked(unsubscribeFrom).mockRejectedValue(new Error("502"));
    setup([listed({ url: "https://news.example/u", oneClick: true })]);
    fireEvent.click(await screen.findByRole("button", { name: "Unsubscribe" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Unsubscribe" })).toHaveProperty("disabled", false);
  });

  it("shows no unsubscribe on ordinary mail", async () => {
    setup([message()]);
    await screen.findByRole("heading", { name: "Cabin weekend" });
    expect(screen.queryByRole("button", { name: "Unsubscribe" })).toBeNull();
  });
});

describe("sender warnings", () => {
  it("warns when the display name claims an address on another domain", async () => {
    setup([message({ msg_from: '"Chase Bank <alerts@chase.com>" <alerts@ch4se.example>', from_addr: "alerts@ch4se.example" })]);
    const warning = await screen.findByRole("note", { name: "Sender warning" });
    expect(warning.textContent).toContain("alerts@chase.com");
    expect(warning.textContent).toContain("alerts@ch4se.example");
    // Not an alert: that would be announced for every flagged message on every open.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("warns when the message failed DMARC", async () => {
    setup([message({ body: { text: "x", html: "", attachments: [], headers: { auth: { spf: "fail", dkim: "none", dmarc: "fail" } } } })]);
    expect((await screen.findByRole("note", { name: "Sender warning" })).textContent).toContain(
      "failed the sender check for okafor.example",
    );
  });

  it("stays quiet for ordinary mail and for my own sent mail", async () => {
    setup([
      message(),
      message({ id: "m2", direction: "out", msg_from: "hello@example.com", body: { text: "x", html: "", attachments: [], headers: { auth: { spf: "fail", dkim: "fail", dmarc: "fail" } } } }),
    ]);
    await screen.findByRole("heading", { name: "Cabin weekend" });
    expect(screen.queryByRole("note", { name: "Sender warning" })).toBeNull();
  });
});

describe("a truncated conversation", () => {
  it("shows the real total and says earlier messages are not shown", async () => {
    setup([message(), message({ id: "m2" })], { total: 105, truncated: true });
    expect(await screen.findByText("105 messages")).toBeTruthy();
    expect(screen.getByRole("note").textContent).toContain("Showing the latest 2");
  });
});
