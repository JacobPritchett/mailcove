// Who a reply goes to, and from whom. Every way of starting one (the toolbar,
// a message's menu, the box under the thread, the keyboard) must agree, reply
// all must always be asked for, and an edited reply must never be re-aimed.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Reader from "../components/Reader";
import type { ComposeInitial } from "../components/ComposeDialog";
import type { ReplyMode } from "../lib/conversation";
import { buildReplyInitial, replyInitialForThread } from "../lib/replyContext";
import { baseLocal, sanitizeLocal } from "../lib/identity";
import type { ThreadMessage } from "../lib/types";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ApiError: actual.ApiError,
    attachmentUrl: actual.attachmentUrl,
    mutateThread: vi.fn(() => Promise.resolve({ ok: true })),
    getIdentities: vi.fn(),
    send: vi.fn(() => Promise.resolve({ ok: true, id: "sent-1" })),
    getThread: vi.fn(),
    putDraft: vi.fn(() => Promise.resolve({ ok: true })),
    deleteDraft: vi.fn(() => Promise.resolve({ ok: true })),
  };
});
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  Toaster: () => null,
}));

import { getIdentities, getThread, send, putDraft } from "../lib/api";

function message(over: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id: "m1", thread_id: "t1", direction: "in", folder: "inbox",
    msg_from: "Maya Okafor <maya@okafor.example>", from_addr: "maya@okafor.example",
    msg_to: "dev@patel.example", msg_cc: "shop@example.com, anna@lindqvist.example",
    subject: "Cabin weekend", snippet: "hi", date: Date.UTC(2026, 9, 1), unread: 0, has_attachments: 0, starred: 0,
    state: "inbox", domain: "example.com", envelope_to: "shop@example.com", message_id: "<m1@okafor.example>",
    body: { text: "Maya asks: yes or no?", html: "", attachments: [] },
    ...over,
  } as ThreadMessage;
}
/** Four people: Maya starts it, Dev answers, Anna answers last. */
const THREAD = [
  message(),
  message({
    id: "m2", msg_from: "Dev Patel <dev@patel.example>", from_addr: "dev@patel.example",
    msg_to: "maya@okafor.example", message_id: "<m2@patel.example>", date: Date.UTC(2026, 9, 2),
    body: { text: "Dev says: I can drive.", html: "", attachments: [] },
  }),
  message({
    id: "m3", msg_from: "Anna <anna@lindqvist.example>", from_addr: "anna@lindqvist.example",
    msg_to: "maya@okafor.example", msg_cc: "dev@patel.example, shop@example.com",
    message_id: "<m3@lindqvist.example>", date: Date.UTC(2026, 9, 3),
    body: { text: "Anna says: yes from me.", html: "", attachments: [] },
  }),
];

function setup(messages: ThreadMessage[] = THREAD) {
  vi.mocked(getThread).mockResolvedValue({ thread_id: "t1", messages });
  const onOpenCompose = vi.fn<(i: ComposeInitial) => void>();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Harness() {
    const [open, setOpen] = useState(false);
    // Deliberately never reset, unlike App: the reader alone must make a
    // closed reply box a plain reply.
    const [mode, setMode] = useState<ReplyMode>("reply");
    const [request, setRequest] = useState({ mode: "reply" as ReplyMode, nonce: 0 });
    return (
      <QueryClientProvider client={qc}>
        <button type="button" onClick={() => setRequest((r) => ({ mode: "reply", nonce: r.nonce + 1 }))}>press r</button>
        <button type="button" onClick={() => setRequest((r) => ({ mode: "reply-all", nonce: r.nonce + 1 }))}>press a</button>
        <Reader
          threadId="t1"
          replyOpen={open}
          onReplyOpenChange={setOpen}
          replyMode={mode}
          onReplyRequest={(m) => {
            setMode(m);
            setOpen(true);
          }}
          replyRequest={request}
          onOpenCompose={onOpenCompose}
          onAction={vi.fn()}
        />
      </QueryClientProvider>
    );
  }
  render(<Harness />);
  return { onOpenCompose };
}

const box = () => screen.getByTestId("inline-reply");
const header = () => box().textContent ?? "";
const body = () => within(box()).getByLabelText("Message") as HTMLTextAreaElement;
const ready = () => screen.findByRole("heading", { name: "Cabin weekend" });
const discard = () => fireEvent.click(screen.getByRole("button", { name: "Discard reply" }));
async function menuReply(index: number, item = "Reply") {
  fireEvent.keyDown(screen.getAllByRole("button", { name: "Message actions" })[index], { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: item }));
}
const lastSend = () => vi.mocked(send).mock.calls.at(-1)![0];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getIdentities).mockResolvedValue({
    identities: [{ domain: "example.com", sendingDomain: "send.example.com", displayName: "S", signature: "" }],
    defaultLocal: "hello",
    defaultDomain: "example.com",
  });
});

describe("reply all is always a deliberate choice", () => {
  it("does not stick: after a discarded reply all, the box under the thread is a plain reply", async () => {
    setup();
    await ready();
    fireEvent.click(screen.getAllByRole("button", { name: "Reply all" }).at(-1)!);
    await waitFor(() => expect(header()).toContain("and 2 more"));
    discard();

    // The closed box says who a click will write to: the sender, nobody else.
    await waitFor(() => expect(box()).toHaveTextContent("Reply to anna@lindqvist.example"));
    fireEvent.click(box());
    await waitFor(() => expect(header()).toContain("Replying to anna@lindqvist.example"));
    expect(header()).not.toContain("more");

    fireEvent.change(body(), { target: { value: "just for anna" } });
    fireEvent.click(within(box()).getByRole("button", { name: /Send/ }));
    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(lastSend().to).toBe("anna@lindqvist.example");
    expect(lastSend().cc).toBeUndefined();
  });

  it("does not survive a sent reply all either", async () => {
    setup();
    await ready();
    fireEvent.click(screen.getAllByRole("button", { name: "Reply all" }).at(-1)!);
    await waitFor(() => expect(header()).toContain("and 2 more"));
    fireEvent.change(body(), { target: { value: "to everyone" } });
    fireEvent.click(within(box()).getByRole("button", { name: /Send/ }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(lastSend().cc).toEqual(["maya@okafor.example", "dev@patel.example"]);

    await waitFor(() => expect(box()).toHaveTextContent("Reply to anna@lindqvist.example"));
    fireEvent.click(box());
    await waitFor(() => expect(header()).toContain("Replying to"));
    expect(header()).not.toContain("more");
  });

  it("the toolbar's Reply is plain too", async () => {
    setup();
    await ready();
    fireEvent.click(screen.getAllByRole("button", { name: "Reply all" }).at(-1)!);
    await waitFor(() => expect(header()).toContain("and 2 more"));
    discard();
    fireEvent.click(await screen.findByRole("button", { name: "Reply" }));
    await waitFor(() => expect(header()).toContain("Replying to"));
    expect(header()).not.toContain("more");
  });
});

describe("a reply answers the latest message unless one is picked", () => {
  it("a message picked from its menu is forgotten once that reply closes", async () => {
    setup();
    await ready();
    await menuReply(0);
    await waitFor(() => expect(header()).toContain("Replying to maya@okafor.example"));
    expect(body().value).toContain("Maya asks");
    discard();

    fireEvent.click(screen.getByRole("button", { name: "press r" }));
    await waitFor(() => expect(header()).toContain("Replying to anna@lindqvist.example"));
    expect(body().value).toContain("Anna says");
    expect(body().value).not.toContain("Maya asks");
    discard();

    // `a`: everyone on the LATEST message, not on the first.
    await menuReply(0);
    await waitFor(() => expect(header()).toContain("Replying to maya"));
    discard();
    fireEvent.click(screen.getByRole("button", { name: "press a" }));
    await waitFor(() => expect(header()).toContain("Replying to anna@lindqvist.example and 2 more"));
    discard();

    // And the box under the thread.
    await menuReply(0);
    await waitFor(() => expect(header()).toContain("Replying to maya"));
    discard();
    await waitFor(() => expect(box()).toHaveTextContent("Reply to anna@lindqvist.example"));
  });

  it("the toolbar's Forward forwards the latest message, not a leftover pick", async () => {
    const { onOpenCompose } = setup();
    await ready();
    await menuReply(0);
    await waitFor(() => expect(header()).toContain("Replying to maya"));
    discard();
    fireEvent.keyDown(screen.getByRole("button", { name: "More actions" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Forward" }));
    expect(onOpenCompose.mock.calls.at(-1)![0].text).toContain("Anna says");

    // Even while a reply to the first message is open.
    await menuReply(0);
    await waitFor(() => expect(header()).toContain("Replying to maya"));
    fireEvent.keyDown(screen.getByRole("button", { name: "More actions" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Forward" }));
    expect(onOpenCompose).toHaveBeenCalledTimes(2);
    expect(onOpenCompose.mock.calls.at(-1)![0].text).toContain("Anna says");
  });

  it("`a` on a message with nobody else on it opens a plain reply", async () => {
    setup([message({ msg_to: "shop@example.com", msg_cc: "" })]);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "press a" }));
    await waitFor(() => expect(header()).toContain("Replying to maya@okafor.example"));
    expect(header()).not.toContain("more");
  });
});

describe("an edited reply is never re-aimed", () => {
  it("asks before replacing it, keeps it on Keep writing, and starts clean on Discard", async () => {
    setup();
    await ready();
    fireEvent.click(await screen.findByRole("button", { name: "Reply" }));
    await waitFor(() => expect(header()).toContain("Replying to anna"));
    fireEvent.change(body(), { target: { value: "SECRET NOTE FOR ANNA" } });

    await menuReply(1);
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Discard this reply and start a new one?");
    // Nothing has changed yet.
    expect(header()).toContain("Replying to anna");
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep writing" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(header()).toContain("Replying to anna");
    expect(body().value).toBe("SECRET NOTE FOR ANNA");

    await menuReply(1);
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Discard and start new" }));
    await waitFor(() => expect(header()).toContain("Replying to dev@patel.example"));
    expect(body().value).not.toContain("SECRET NOTE");
    expect(body().value).toContain("Dev says");
    expect(body().value).not.toContain("Anna says");

    fireEvent.change(body(), { target: { value: "for dev" } });
    fireEvent.click(within(box()).getByRole("button", { name: /Send/ }));
    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(lastSend()).toMatchObject({ to: "dev@patel.example", text: "for dev", inReplyTo: "<m2@patel.example>" });
  });

  it("a stray r is ignored, and a stray a asks", async () => {
    setup();
    await ready();
    fireEvent.click(await screen.findByRole("button", { name: "Reply" }));
    await waitFor(() => expect(header()).toContain("Replying to anna"));
    fireEvent.change(body(), { target: { value: "half written" } });

    fireEvent.click(screen.getByRole("button", { name: "press r" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(body().value).toBe("half written");

    fireEvent.click(screen.getByRole("button", { name: "press a" }));
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    expect(header()).not.toContain("more");
    expect(body().value).toBe("half written");
  });

  it("an untouched reply is re-aimed freely, with the new message quoted", async () => {
    setup();
    await ready();
    fireEvent.click(await screen.findByRole("button", { name: "Reply" }));
    await waitFor(() => expect(body().value).toContain("Anna says"));
    await menuReply(1);
    await waitFor(() => expect(header()).toContain("Replying to dev@patel.example"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(body().value).toContain("Dev says");
    expect(body().value).not.toContain("Anna says");
  });
});

describe("reply all and my own addresses", () => {
  it("does not copy another address of mine on a domain I send from", async () => {
    vi.mocked(getIdentities).mockResolvedValue({
      identities: [
        { domain: "example.com", sendingDomain: "send.example.com", displayName: "S", signature: "" },
        { domain: "example.org", sendingDomain: "send.example.org", displayName: "P", signature: "" },
      ],
      defaultLocal: "hello",
      defaultDomain: "example.com",
    });
    setup([message({ msg_to: "shop@example.com, Alex <alex@example.org>, bob@y.example", msg_cc: "" })]);
    await ready();
    await waitFor(() => expect(getIdentities).toHaveBeenCalled());
    fireEvent.click((await screen.findAllByRole("button", { name: "Reply all" })).at(-1)!);
    fireEvent.change(await waitFor(body), { target: { value: "hi" } });
    fireEvent.click(within(box()).getByRole("button", { name: /Send/ }));
    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(lastSend().cc).toEqual(["bob@y.example"]);
  });

  it("offers no Reply all when everyone else on the message is me", async () => {
    setup([message({ msg_to: "shop@example.com, billing@example.com", msg_cc: "" })]);
    await ready();
    await screen.findByRole("button", { name: "Reply" });
    expect(screen.queryByRole("button", { name: "Reply all" })).toBeNull();
  });
});

describe("the From shown is the From used", () => {
  it("answers mail sent to a plus tag from the mailbox itself", async () => {
    expect(baseLocal("me+shop")).toBe("me");
    expect(baseLocal("first.last+a+b")).toBe("first.last");
    expect(sanitizeLocal("me+shop")).toBe("meshop"); // what the Worker would have made of it
    const m = message({ envelope_to: "me+shop@example.com", msg_to: "me+shop@example.com", msg_cc: "" });
    expect(buildReplyInitial({ message: m, body: m.body }).fromLocal).toBe("me");

    setup([m]);
    await ready();
    fireEvent.click(await screen.findByRole("button", { name: "Reply" }));
    await waitFor(() => expect(header()).toContain("as me@example.com"));
    fireEvent.change(body(), { target: { value: "hi" } });
    fireEvent.click(within(box()).getByRole("button", { name: /Send/ }));
    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(lastSend()).toMatchObject({ from: "me@example.com", fromLocal: "me" });
  });

  it("uses the default mailbox, not the original local part, when the reply domain cannot send", async () => {
    setup([
      message({
        domain: "recvonly.example", envelope_to: "sales@recvonly.example", msg_to: "sales@recvonly.example", msg_cc: "",
      }),
    ]);
    await ready();
    fireEvent.click(await screen.findByRole("button", { name: "Reply" }));
    await waitFor(() => expect(header()).toContain("as hello@example.com"));
    expect(header()).not.toContain("sales@");
    fireEvent.change(body(), { target: { value: "hi" } });
    fireEvent.click(within(box()).getByRole("button", { name: /Send/ }));
    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(lastSend()).toMatchObject({ from: "hello@example.com", fromLocal: "hello" });
  });
});


describe("reply sender display name", () => {
  const sent = (name: string, date: number) => message({
    id: `sent-${date}`, direction: "out", date,
    msg_from: `${name} <shop@example.com>`,
  });

  it("uses the earliest outbound name even when answering inbound mail or a later send", () => {
    const messages = [sent("Later Name", 20), message(), sent('"Original, Name"', 10)];
    expect(replyInitialForThread("t1", messages)?.fromName).toBe("Original, Name");
    expect(replyInitialForThread("t1", messages, "reply-all", "sent-20")?.fromName).toBe("Original, Name");
  });

  it("uses the stored outbound name and skips legacy sends with no saved name", () => {
    const legacy = message({ direction: "out", date: 1, msg_from: "shop@example.com" });
    const named = message({ direction: "out", date: 2, msg_from: "shop@example.com", body: {
      text: "hi", html: "", attachments: [], headers: { fromName: "Saved Name" },
    } });
    expect(replyInitialForThread("t1", [legacy, named, message()])?.fromName).toBe("Saved Name");
  });

  it("does not borrow an inbound name or turn a bare sender address into a name", () => {
    expect(replyInitialForThread("t1", [message()])?.fromName).toBeUndefined();
    expect(replyInitialForThread("t1", [message({ direction: "out", msg_from: "shop@example.com" })])?.fromName).toBeUndefined();
  });

  it("sends the inherited name from the inline composer", async () => {
    setup([sent("Chosen Name", 1), message()]);
    await ready();
    fireEvent.click(box());
    expect(await screen.findByRole("textbox", { name: "From name" })).toHaveValue("Chosen Name");
    fireEvent.change(body(), { target: { value: "reply" } });
    fireEvent.click(within(box()).getByRole("button", { name: /Send/ }));
    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(lastSend().fromName).toBe("Chosen Name");
  });

  it("preserves an edited name in the draft and expanded composer", async () => {
    const { onOpenCompose } = setup([sent("Chosen Name", 1), message()]);
    await ready();
    fireEvent.click(box());
    fireEvent.change(await screen.findByRole("textbox", { name: "From name" }), { target: { value: "New Name" } });
    fireEvent.change(body(), { target: { value: "reply" } });
    await waitFor(() => expect(putDraft).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ fromName: "New Name" })), { timeout: 3000 });
    fireEvent.click(screen.getByRole("button", { name: "Open in full composer" }));
    expect(onOpenCompose).toHaveBeenCalledWith(expect.objectContaining({ fromName: "New Name" }));
  });
});
