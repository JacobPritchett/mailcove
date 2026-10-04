// A calendar invite attached to a message shows as a card above the body,
// read on the client from the .ics bytes and rendered as plain text.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Reader from "../components/Reader";
import { formatIcsWhen, parseIcs, ICS_MAX_BYTES } from "../lib/ics";
import type { ThreadMessage } from "../lib/types";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ApiError: actual.ApiError,
    attachmentUrl: actual.attachmentUrl,
    getAttachmentText: vi.fn(),
    mutateThread: vi.fn(() => Promise.resolve({ ok: true })),
    getIdentities: vi.fn(() =>
      Promise.resolve({ identities: [], defaultLocal: "hello", defaultDomain: "example.com" }),
    ),
    send: vi.fn(),
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

import { getThread, getAttachmentText } from "../lib/api";

const ics = (lines: string[], calendar: string[] = ["METHOD:REQUEST"]) =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", ...calendar, "BEGIN:VEVENT", "UID:1@example.org", ...lines, "END:VEVENT", "END:VCALENDAR"].join("\r\n");

const SIGNING = ics([
  "DTSTART:20261114T170000Z",
  "DTEND:20261114T180000Z",
  "SUMMARY:Lease signing",
  "LOCATION:400 E Van Buren St\\, Phoenix",
  'ORGANIZER;CN="Rosa Alvarez":mailto:leasing@harborview.example',
]);

function message(n: number, attachments: unknown[]): ThreadMessage {
  return {
    id: `m${n}`, thread_id: "t1", direction: "in", folder: "inbox",
    msg_from: "Harborview Leasing <leasing@harborview.example>", from_addr: "leasing@harborview.example",
    msg_to: "me@example.com", msg_cc: null, subject: "Signing appointment", snippet: `Snippet ${n}`,
    date: Date.UTC(2026, 9, 1, n), unread: 0, has_attachments: 1, starred: 0, domain: "example.com",
    envelope_to: "me@example.com", message_id: `<m${n}@example.com>`,
    body: { text: "", html: "<p>See the invite.</p>", attachments },
  } as unknown as ThreadMessage;
}
const INVITE = { name: "invite.ics", mimeType: "text/calendar", size: 400, partId: "p1" };

function setup(messages: ThreadMessage[]) {
  vi.mocked(getThread).mockResolvedValue({ thread_id: "t1", messages });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Reader threadId="t1" replyOpen={false} onReplyOpenChange={vi.fn()} onOpenCompose={vi.fn()} onAction={vi.fn()} />
    </QueryClientProvider>,
  );
}
const card = () => screen.findByRole("region", { name: "Calendar invite" });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAttachmentText).mockResolvedValue(SIGNING);
});

describe("the invite card", () => {
  it("shows the title, the time in the reader's zone, the place and the organizer", async () => {
    setup([message(1, [{ name: "lease.pdf", mimeType: "application/pdf", size: 9000, partId: "p0" }, INVITE])]);
    const c = await card();
    expect(within(c).getByText("Lease signing")).toBeInTheDocument();
    // Whatever zone this runs in: the same instant, formatted for it.
    expect(within(c).getByText(formatIcsWhen(parseIcs(SIGNING)!))).toBeInTheDocument();
    expect(within(c).getByText("400 E Van Buren St, Phoenix")).toBeInTheDocument();
    expect(within(c).getByText("Rosa Alvarez, leasing@harborview.example")).toBeInTheDocument();
    expect(getAttachmentText).toHaveBeenCalledWith("m1", "invite.ics", "p1", ICS_MAX_BYTES);
  });

  it("sits above the body and offers the file itself", async () => {
    setup([message(1, [INVITE])]);
    const c = await card();
    const frame = document.querySelector("iframe")!;
    expect(c.compareDocumentPosition(frame) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const link = within(c).getByRole("link", { name: "Download .ics" });
    expect(link).toHaveAttribute("href", "/api/attachments/m1/invite.ics?part=p1");
    expect(link).toHaveAttribute("download", "invite.ics");
  });

  it("recognises a calendar file by its name when the type is generic", async () => {
    setup([message(1, [{ name: "Meeting.ICS", mimeType: "application/octet-stream", size: 400, partId: "p0" }])]);
    expect(await card()).toBeInTheDocument();
  });

  it("renders markup in the invite as the text it is", async () => {
    vi.mocked(getAttachmentText).mockResolvedValue(
      ics(["DTSTART:20261114T170000Z", "SUMMARY:<img src=x onerror=alert(1)><b>Bold</b>", "LOCATION:<script>alert(2)</script>"]),
    );
    setup([message(1, [INVITE])]);
    const c = await card();
    expect(within(c).getByText("<img src=x onerror=alert(1)><b>Bold</b>")).toBeInTheDocument();
    expect(c.querySelector("img, b, script")).toBeNull();
  });

  it("says when an event is cancelled, repeats, or lasts all day", async () => {
    vi.mocked(getAttachmentText).mockResolvedValue(
      ics(["DTSTART;VALUE=DATE:20261114", "DTEND;VALUE=DATE:20261115", "SUMMARY:Offsite", "RRULE:FREQ=YEARLY"], ["METHOD:CANCEL"]),
    );
    setup([message(1, [INVITE])]);
    const c = await card();
    expect(within(c).getByText("Cancelled:")).toBeInTheDocument();
    expect(within(c).getByText(/all day/)).toBeInTheDocument();
    expect(within(c).getByText("Repeats")).toBeInTheDocument();
  });

  it("says so when the invite gives no time zone", async () => {
    vi.mocked(getAttachmentText).mockResolvedValue(ics(["DTSTART:20261114T170000", "SUMMARY:Call"]));
    setup([message(1, [INVITE])]);
    expect(within(await card()).getByText("The invite gives no time zone. Shown as written.")).toBeInTheDocument();
  });
});

describe("when there is nothing to show", () => {
  const settle = () => new Promise((r) => setTimeout(r, 50));

  it("shows no card for a message without a calendar file, and fetches nothing", async () => {
    setup([message(1, [{ name: "lease.pdf", mimeType: "application/pdf", size: 9000, partId: "p0" }])]);
    await screen.findByRole("link", { name: /lease\.pdf/ });
    await settle();
    expect(screen.queryByRole("region", { name: "Calendar invite" })).toBeNull();
    expect(getAttachmentText).not.toHaveBeenCalled();
  });

  it("does not fetch a calendar file that is too large or was never stored", async () => {
    setup([
      message(1, [
        { ...INVITE, size: ICS_MAX_BYTES + 1 },
        { ...INVITE, name: "other.ics", partId: "p2", stored: false },
      ]),
    ]);
    await screen.findByRole("link", { name: /invite\.ics/ });
    await settle();
    expect(getAttachmentText).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Calendar invite" })).toBeNull();
  });

  it("shows no card, and keeps the attachment, when the file cannot be read or is not a calendar", async () => {
    vi.mocked(getAttachmentText).mockRejectedValueOnce(new Error("offline"));
    setup([message(1, [INVITE])]);
    await waitFor(() => expect(getAttachmentText).toHaveBeenCalled());
    await settle();
    expect(screen.queryByRole("region", { name: "Calendar invite" })).toBeNull();
    expect(screen.getByRole("link", { name: /invite\.ics/ })).toBeInTheDocument();
  });

  it("does not read the invite of a folded message until it is unfolded", async () => {
    setup([message(1, [INVITE]), message(2, []), message(3, []), message(4, [])]);
    await screen.findByText("4 messages");
    await settle();
    expect(getAttachmentText).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: /^Expand message from/ })[0]);
    expect(await card()).toBeInTheDocument();
    expect(getAttachmentText).toHaveBeenCalledTimes(1);
  });
});
