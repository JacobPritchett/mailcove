/**
 * Tests for ChatView — safe chat-bubble renderer (Task 2.1)
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ChatView from "@/components/ChatView";
import type { ThreadResponse } from "@/lib/types";

// ChatView uses attachmentUrl from @/lib/api
vi.mock("@/lib/api", () => ({
  attachmentUrl: vi.fn((id: string, name: string) => `/api/attachments/${id}/${name}`),
}));

const body = (text: string) => ({ text, html: "", attachments: [] });

const STUB: ThreadResponse = {
  thread_id: "t1",
  messages: [
    {
      id: "m1",
      thread_id: "t1",
      direction: "in",
      folder: "inbox",
      msg_from: "Alice <a@x.com>",
      msg_to: "me@y.com",
      subject: "Hi",
      snippet: "",
      date: 1,
      unread: 0,
      has_attachments: 0,
      body: body("visible reply\n\nOn Mon, Bob wrote:\n> old quoted line"),
    } as any,
  ],
};

it("renders bubbles and toggles quoted text", () => {
  render(<ChatView data={STUB} />);
  expect(screen.getByText(/visible reply/i)).toBeInTheDocument();
  expect(screen.queryByText(/old quoted line/i)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /quoted/i }));
  expect(screen.getByText(/old quoted line/i)).toBeInTheDocument();
});

it("renders a malicious html body as inert text, not an element", () => {
  const mal: ThreadResponse = {
    thread_id: "t2",
    messages: [
      {
        id: "m2",
        thread_id: "t2",
        direction: "in",
        folder: "inbox",
        msg_from: "x@x.com",
        msg_to: "y",
        subject: "",
        snippet: "",
        date: 1,
        unread: 0,
        has_attachments: 0,
        body: { text: "", html: `<img src=x onerror="alert(1)">hello`, attachments: [] },
      } as any,
    ],
  };
  render(<ChatView data={mal} />);
  expect(document.querySelector("img")).toBeNull();
  expect(screen.getByText(/hello/i)).toBeInTheDocument();
});

describe("ChatView — multi-message thread", () => {
  const MULTI: ThreadResponse = {
    thread_id: "t3",
    messages: [
      {
        id: "m3a",
        thread_id: "t3",
        direction: "in",
        folder: "inbox",
        msg_from: "Alice <a@x.com>",
        msg_to: "me@y.com",
        subject: "Thread",
        snippet: "",
        date: 1000,
        unread: 0,
        has_attachments: 0,
        body: body("first message"),
      } as any,
      {
        id: "m3b",
        thread_id: "t3",
        direction: "out",
        folder: "sent",
        msg_from: "me@y.com",
        msg_to: "Alice <a@x.com>",
        subject: "Thread",
        snippet: "",
        date: 2000,
        unread: 0,
        has_attachments: 0,
        body: body("second message reply"),
      } as any,
    ],
  };

  it("renders all messages", () => {
    render(<ChatView data={MULTI} />);
    expect(screen.getByText(/first message/i)).toBeInTheDocument();
    expect(screen.getByText(/second message reply/i)).toBeInTheDocument();
  });
});

describe("ChatView — signature toggle", () => {
  const WITH_SIG: ThreadResponse = {
    thread_id: "t4",
    messages: [
      {
        id: "m4",
        thread_id: "t4",
        direction: "in",
        folder: "inbox",
        msg_from: "Bob <b@x.com>",
        msg_to: "me@y.com",
        subject: "Sig test",
        snippet: "",
        date: 1,
        unread: 0,
        has_attachments: 0,
        body: body("Hello there\n-- \nBob\nCEO"),
      } as any,
    ],
  };

  it("hides signature by default and shows it when toggled", () => {
    render(<ChatView data={WITH_SIG} />);
    expect(screen.getByText(/Hello there/i)).toBeInTheDocument();
    expect(screen.queryByText(/CEO/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /signature/i }));
    expect(screen.getByText(/CEO/i)).toBeInTheDocument();
  });
});

describe("ChatView — attachments", () => {
  it("renders attachment chips with correct href", () => {
    const ATTACH: ThreadResponse = {
      thread_id: "t5",
      messages: [
        {
          id: "m5",
          thread_id: "t5",
          direction: "in",
          folder: "inbox",
          msg_from: "Carol <c@x.com>",
          msg_to: "me@y.com",
          subject: "Attachments",
          snippet: "",
          date: 1,
          unread: 0,
          has_attachments: 1,
          body: {
            text: "See attached",
            html: "",
            attachments: [{ name: "file.pdf", mimeType: "application/pdf", size: 1000 }],
          },
        } as any,
      ],
    };
    render(<ChatView data={ATTACH} />);
    const link = screen.getByRole("link", { name: /file\.pdf/i });
    expect(link).toHaveAttribute("href", "/api/attachments/m5/file.pdf");
  });
});
