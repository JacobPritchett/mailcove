// Printing from the reader: the conversation (or one message) is laid out as
// a document, the message frames stay sandboxed, and the app comes back as it
// was when the print dialog closes.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Reader from "../components/Reader";
import { enterPrintLayout, markKeepTogether } from "../lib/print";
import { IFRAME_SANDBOX } from "../lib/emailFrame";
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

import { getThread } from "../lib/api";

function message(n: number, over: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id: `m${n}`, thread_id: "t1", direction: "in", folder: "inbox",
    msg_from: `Sender ${n} <s${n}@example.com>`, from_addr: `s${n}@example.com`,
    msg_to: "me@example.com, other@example.com", msg_cc: n === 5 ? "copied@example.com" : null,
    subject: "Planning", snippet: `Snippet ${n}`, date: Date.UTC(2026, 9, 1, n), unread: 0, has_attachments: 0,
    starred: 0, domain: "example.com", envelope_to: "me@example.com", message_id: `<m${n}@example.com>`,
    body: {
      text: "",
      html: `<p>Body ${n}</p>`,
      attachments: n === 5 ? [{ name: "agenda.pdf", mimeType: "application/pdf", size: 10, partId: "p0" }] : [],
    },
    ...over,
  } as ThreadMessage;
}

function setup(count = 5, over: Record<number, Partial<ThreadMessage>> = {}) {
  vi.mocked(getThread).mockResolvedValue({
    thread_id: "t1",
    messages: Array.from({ length: count }, (_, i) => message(i + 1, over[i + 1])),
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Reader threadId="t1" replyOpen={false} onReplyOpenChange={vi.fn()} onOpenCompose={vi.fn()} onAction={vi.fn()} />
    </QueryClientProvider>,
  );
}

async function choose(trigger: HTMLElement, item: string) {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole("menuitem", { name: item }));
}
const frames = () => Array.from(document.querySelectorAll("iframe"));
const root = () => document.documentElement;
const printed = () => waitFor(() => expect(window.print).toHaveBeenCalledTimes(1), { timeout: 5000 });

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  window.print = vi.fn();
  root().className = "";
});
afterEach(() => {
  root().className = "";
});

describe("printing a conversation", () => {
  it("unfolds every message, shows who and when in full, and prints once the frames have settled", async () => {
    setup();
    await screen.findByText("5 messages");
    expect(frames()).toHaveLength(1);
    await choose(screen.getByRole("button", { name: "More actions" }), "Print");

    expect(root()).toHaveClass("printing");
    expect(frames()).toHaveLength(5);
    // Recipients, Cc and the exact date of every message, not only "to me".
    const last = screen.getByRole("region", { name: "Message from Sender 5" });
    expect(within(last).getByText("me@example.com, other@example.com")).toBeInTheDocument();
    expect(within(last).getByText("copied@example.com")).toBeInTheDocument();
    expect(within(last).getByText(new Date(Date.UTC(2026, 9, 1, 5)).toLocaleString())).toBeInTheDocument();
    expect(within(last).getByRole("link", { name: /agenda\.pdf/ })).toBeInTheDocument();
    await printed();
  });

  it("leaves the sandbox and the frame's policy exactly as they are on screen", async () => {
    setup();
    await screen.findByText("5 messages");
    const before = frames()[0].getAttribute("srcdoc");
    await choose(screen.getByRole("button", { name: "More actions" }), "Print");
    for (const f of frames()) {
      expect(f.getAttribute("sandbox")).toBe(IFRAME_SANDBOX);
      expect(f.getAttribute("sandbox")).not.toMatch(/allow-scripts|allow-modals|allow-popups/);
      expect(f.getAttribute("srcdoc")).toContain("default-src 'none'");
    }
    // The open message's document is the same one, not a rebuilt copy.
    expect(frames()[4].getAttribute("srcdoc")).toBe(before);
    // And no mail HTML outside a frame.
    expect(document.querySelector("[data-print-root]")!.innerHTML.replace(/srcdoc="[^"]*"/g, "")).not.toContain("Body 3");
    await printed();
  });

  it("goes back to the app as it was when the print dialog closes", async () => {
    root().classList.add("dark");
    setup();
    await screen.findByText("5 messages");
    await choose(screen.getByRole("button", { name: "More actions" }), "Print");
    expect(root()).not.toHaveClass("dark");
    await printed();
    act(() => {
      window.dispatchEvent(new Event("afterprint"));
    });
    expect(root()).not.toHaveClass("printing");
    expect(root()).toHaveClass("dark");
    expect(frames()).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /^Expand message from/ })).toHaveLength(4);
  });

  it("offers a way back if the dialog never reports closing", async () => {
    setup();
    await screen.findByText("5 messages");
    await choose(screen.getByRole("button", { name: "More actions" }), "Print");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(root()).not.toHaveClass("printing");
    expect(frames()).toHaveLength(1);
  });

  it("prints a chat-mode conversation as the formatted messages", async () => {
    localStorage.setItem("reader.viewMode", "chat");
    setup(2);
    await screen.findByText("2 messages");
    expect(frames()).toHaveLength(0);
    await choose(screen.getByRole("button", { name: "More actions" }), "Print");
    expect(frames()).toHaveLength(2);
    await printed();
  });
});

describe("printing one message", () => {
  it("shows that message alone, then puts the conversation back", async () => {
    setup(3);
    await screen.findByText("3 messages");
    const second = screen.getByRole("region", { name: "Message from Sender 2" });
    await choose(within(second).getByRole("button", { name: "Message actions" }), "Print");
    expect(frames().map((f) => f.title)).toEqual(["Message from Sender 2 <s2@example.com>"]);
    await printed();
    act(() => {
      window.dispatchEvent(new Event("afterprint"));
    });
    expect(frames()).toHaveLength(3);
  });
});

describe("Cmd/Ctrl+P", () => {
  it("prints the open conversation the prepared way", async () => {
    setup();
    await screen.findByText("5 messages");
    const event = new KeyboardEvent("keydown", { key: "p", metaKey: true, bubbles: true, cancelable: true });
    act(() => {
      document.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(root()).toHaveClass("printing");
    expect(frames()).toHaveLength(5);
    await printed();
  });

  it("is left to the browser while a dialog is open over the conversation", async () => {
    setup();
    await screen.findByText("5 messages");
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.appendChild(dialog);
    const event = new KeyboardEvent("keydown", { key: "p", ctrlKey: true, bubbles: true, cancelable: true });
    act(() => {
      document.dispatchEvent(event);
    });
    dialog.remove();
    expect(event.defaultPrevented).toBe(false);
    expect(root()).not.toHaveClass("printing");
  });

  it("a print started from the browser's own menu still gets the print layout", async () => {
    setup();
    await screen.findByText("5 messages");
    window.dispatchEvent(new Event("beforeprint"));
    expect(root()).toHaveClass("printing");
    window.dispatchEvent(new Event("afterprint"));
    expect(root()).not.toHaveClass("printing");
  });
});

describe("print layout helpers", () => {
  it("is counted: the layout stays until the last holder leaves, and dark mode comes back", () => {
    root().classList.add("dark");
    const a = enterPrintLayout();
    const b = enterPrintLayout();
    expect(root().className).toBe("printing");
    a();
    a(); // leaving twice counts once
    expect(root()).toHaveClass("printing");
    b();
    expect(root().className).toBe("dark");
  });

  it("marks only the messages that fit on a page to be kept together", () => {
    const host = document.createElement("div");
    host.innerHTML = `<section data-message-open id="short"></section><section data-message-open id="tall"></section>`;
    const height = (id: string, h: number) =>
      Object.defineProperty(host.querySelector(`#${id}`)!, "offsetHeight", { configurable: true, value: h });
    height("short", 300);
    height("tall", 2400);
    markKeepTogether(host);
    expect(host.querySelector("#short")!.hasAttribute("data-print-keep")).toBe(true);
    expect(host.querySelector("#tall")!.hasAttribute("data-print-keep")).toBe(false);
  });
});
