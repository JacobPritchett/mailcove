import { describe, it, expect } from "vitest";
import {
  deliveredTo,
  forwardableParts,
  forwardBody,
  forwardSubject,
  hasReplyAll,
  ownDomains,
  replyRecipients,
  replySubject,
} from "@/lib/conversation";
import type { ThreadMessage } from "@/lib/types";

function msg(over: Partial<ThreadMessage> & { headers?: Record<string, unknown> } = {}): ThreadMessage {
  const { headers, ...rest } = over;
  return {
    id: "m1",
    thread_id: "t1",
    direction: "in",
    folder: "inbox",
    msg_from: "Maya Okafor <maya@okafor.example>",
    msg_to: "dev@patel.example",
    msg_cc: 'me@example.com, "Lindqvist, Anna" <anna@lindqvist.example>',
    subject: "Cabin weekend",
    snippet: "",
    date: Date.UTC(2026, 9, 2, 16, 30),
    unread: 0,
    has_attachments: 0,
    domain: "example.com",
    envelope_to: "me@example.com",
    body: { text: "Yes or no?", html: "", attachments: [], headers: headers as never },
    ...rest,
  } as ThreadMessage;
}

describe("replyRecipients", () => {
  it("replies to the sender only", () => {
    expect(replyRecipients(msg(), "reply")).toEqual({ to: ["maya@okafor.example"], cc: [] });
  });

  it("reply all keeps everyone else and never adds me back", () => {
    expect(replyRecipients(msg(), "reply-all")).toEqual({
      to: ["maya@okafor.example"],
      cc: ["dev@patel.example", "anna@lindqvist.example"],
    });
  });

  it("honours Reply-To, and reply all still includes the sender", () => {
    const m = msg({ headers: { replyTo: [{ name: "List", address: "list@group.example" }] } });
    expect(replyRecipients(m, "reply")).toEqual({ to: ["list@group.example"], cc: [] });
    expect(replyRecipients(m, "reply-all")).toEqual({
      to: ["list@group.example"],
      cc: ["maya@okafor.example", "dev@patel.example", "anna@lindqvist.example"],
    });
  });

  it("ignores an unusable Reply-To", () => {
    const m = msg({ headers: { replyTo: [{ name: "x", address: "not-an-address" }] } });
    expect(replyRecipients(m, "reply").to).toEqual(["maya@okafor.example"]);
  });

  it("follows up on my own sent mail with the same people", () => {
    const m = msg({ direction: "out", msg_from: "me@example.com", msg_to: "maya@okafor.example, dev@patel.example", msg_cc: "anna@lindqvist.example" });
    expect(replyRecipients(m, "reply")).toEqual({ to: ["maya@okafor.example", "dev@patel.example"], cc: [] });
    expect(replyRecipients(m, "reply-all")).toEqual({
      to: ["maya@okafor.example", "dev@patel.example"],
      cc: ["anna@lindqvist.example"],
    });
  });

  it("dedupes case-insensitively and drops my other addresses", () => {
    const m = msg({ msg_to: "MAYA@okafor.example, Me@Example.com, alias@example.org", msg_cc: "dev@patel.example, DEV@patel.example" });
    expect(replyRecipients(m, "reply-all", ["alias@example.org"])).toEqual({
      to: ["maya@okafor.example"],
      cc: ["dev@patel.example"],
    });
  });

  it("returns no recipients rather than a junk address", () => {
    expect(replyRecipients(msg({ msg_from: "MAILER-DAEMON" }), "reply")).toEqual({ to: [], cc: [] });
  });
});

describe("hasReplyAll", () => {
  it("is true only when reply all reaches more people", () => {
    expect(hasReplyAll(msg())).toBe(true);
    expect(hasReplyAll(msg({ msg_to: "me@example.com", msg_cc: null }))).toBe(false);
  });
});

describe("deliveredTo", () => {
  it("prefers the envelope recipient", () => {
    expect(deliveredTo(msg({ envelope_to: "Shop@Example.com" }))).toBe("shop@example.com");
  });
  it("falls back to a To/Cc address on the message domain", () => {
    expect(deliveredTo(msg({ envelope_to: null }))).toBe("me@example.com");
    expect(deliveredTo(msg({ envelope_to: null, msg_cc: null, domain: "example.com" }))).toBeNull();
  });
});

describe("subjects", () => {
  it("adds a prefix once", () => {
    expect(replySubject("Hello")).toBe("Re: Hello");
    expect(replySubject("RE: Hello")).toBe("RE: Hello");
    expect(forwardSubject("Hello")).toBe("Fwd: Hello");
    expect(forwardSubject("Fw: Hello")).toBe("Fw: Hello");
    expect(forwardSubject("FWD: Hello")).toBe("FWD: Hello");
    expect(forwardSubject("Re: Hello")).toBe("Fwd: Re: Hello");
  });
});

describe("forward", () => {
  const file = (over: Record<string, unknown>) => ({ mimeType: "application/pdf", size: 1, ...over });

  it("carries stored files and names the ones whose bytes were never kept", () => {
    const m = msg({
      body: {
        text: "",
        html: "",
        attachments: [
          file({ name: "a.pdf", partId: "p0" }),
          file({ name: "b.zip", partId: "p1", stored: false }),
        ],
      } as never,
    });
    expect(forwardableParts(m)).toEqual({
      parts: [{ partId: "p0", name: "a.pdf", type: "application/pdf", size: 1 }],
      notStored: ["b.zip"],
    });
  });

  it("carries a real attachment that happens to have a Content-ID (Outlook, Apple Mail)", () => {
    const m = msg({
      body: {
        text: "",
        html: "<p>see attached</p>",
        attachments: [file({ name: "contract.pdf", partId: "p1", disposition: "attachment", contentId: "f_abc123" })],
      } as never,
    });
    expect(forwardableParts(m).parts.map((p) => p.name)).toEqual(["contract.pdf"]);
  });

  it("leaves out, without comment, only an inline image the body itself shows", () => {
    const m = msg({
      body: {
        text: "",
        html: '<p><img src="cid:logo1"></p>',
        attachments: [
          file({ name: "logo.png", partId: "p0", disposition: "inline", contentId: "<logo1>" }),
          // Marked inline but never referenced: the reader lists it as a file, so it travels.
          file({ name: "photo.jpg", partId: "p2", disposition: "inline", contentId: "unused" }),
          // Referenced by cid but sent as an attachment: still a file.
          file({ name: "chart.png", partId: "p3", disposition: "attachment", contentId: "logo1" }),
        ],
      } as never,
    });
    expect(forwardableParts(m)).toEqual({
      parts: [
        { partId: "p2", name: "photo.jpg", type: "application/pdf", size: 1 },
        { partId: "p3", name: "chart.png", type: "application/pdf", size: 1 },
      ],
      notStored: [],
    });
  });

  it("leads with a blank line and the original, unquoted", () => {
    const body = forwardBody(msg());
    expect(body.startsWith("\n\n---------- Forwarded message ----------\n")).toBe(true);
    expect(body).toContain("From: Maya Okafor <maya@okafor.example>");
    expect(body).toContain("Subject: Cabin weekend");
    expect(body).toContain("To: dev@patel.example");
    expect(body).toContain("Cc: me@example.com");
    expect(body.endsWith("\nYes or no?")).toBe(true);
    expect(body).not.toContain("> Yes");
  });
});

describe("reply all and my own addresses", () => {
  it("leaves out every address on a domain this inbox receives for", () => {
    const m = msg({ msg_to: "me@example.com, Alex <alex@other-inbox.example>, bob@y.example", msg_cc: "" });
    // Without knowing the other domain is mine, my second address is copied.
    expect(replyRecipients(m, "reply-all").cc).toEqual(["alex@other-inbox.example", "bob@y.example"]);
    const mine = ownDomains(["example.com", "Other-Inbox.example"], [m]);
    expect(replyRecipients(m, "reply-all", mine).cc).toEqual(["bob@y.example"]);
  });

  it("learns a receiving domain from the conversation itself", () => {
    const m = msg({ domain: "recvonly.example", envelope_to: "sales@recvonly.example", msg_to: "sales@recvonly.example, info@recvonly.example, bob@y.example", msg_cc: "" });
    expect(ownDomains([], [m])).toEqual(["@recvonly.example"]);
    expect(replyRecipients(m, "reply-all", ownDomains([], [m])).cc).toEqual(["bob@y.example"]);
  });

  it("offers no reply all when the only other recipients are me", () => {
    const m = msg({ msg_to: "me@example.com, alex@other-inbox.example", msg_cc: "" });
    expect(hasReplyAll(m)).toBe(true);
    expect(hasReplyAll(m, ownDomains(["other-inbox.example"], [m]))).toBe(false);
  });

  it("still replies to a sender on my own domain", () => {
    const m = msg({ msg_from: "Me <me@example.com>", msg_to: "me@example.com", msg_cc: "" });
    expect(replyRecipients(m, "reply", ownDomains(["example.com"], [m])).to).toEqual(["me@example.com"]);
  });
});
