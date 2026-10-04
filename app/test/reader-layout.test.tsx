/**
 * The reader's chrome: one toolbar row with the rest under More, the phone's
 * top bar, the conversation heading, and "You" on sent mail.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Reader from "../components/Reader";
import type { ThreadMessage, ThreadResponse } from "../lib/types";

vi.mock("../lib/api", () => ({
  ApiError: class ApiError extends Error { status = 0; },
  mutateThread: vi.fn(() => Promise.resolve({ ok: true })),
  getThread: vi.fn(),
  getIdentities: vi.fn(() => Promise.resolve({ identities: [], defaultLocal: "hello", defaultDomain: "example.com" })),
  summarizeThread: vi.fn(() => Promise.resolve({ ok: true, summary: "They agreed on Friday." })),
  attachmentUrl: vi.fn(),
}));

import { getThread, summarizeThread } from "../lib/api";

const IN: ThreadMessage = {
  id: "m1", thread_id: "t1", direction: "in", folder: "inbox", msg_from: "Alice <alice@example.com>",
  from_addr: "alice@example.com", msg_to: "hello@example.com, bob@example.com", subject: "Lunch on Friday",
  snippet: "hi", date: Date.now() - 3_600_000, unread: 0, has_attachments: 0, state: "inbox", starred: 0,
  body: { text: "Shall we?", html: "", attachments: [] },
};
const OUT: ThreadMessage = {
  ...IN, id: "m2", direction: "out", msg_from: "Alex P <hello@example.com>", from_addr: "hello@example.com",
  msg_to: "alice@example.com", subject: "RE: Re: Fwd: Lunch on Friday", date: Date.now(),
  body: { text: "Yes.", html: "", attachments: [] },
};
const THREAD: ThreadResponse = { thread_id: "t1", messages: [IN, OUT] };

function setDesktop(isDesktop: boolean) {
  window.matchMedia = ((query: string) =>
    ({
      matches: /min-width:\s*768px/.test(query) ? isDesktop : false,
      media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
}

function renderReader(props: Partial<React.ComponentProps<typeof Reader>> = {}) {
  const onAction = vi.fn();
  const onReplyRequest = vi.fn();
  const onOpenCompose = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <Reader
        threadId="t1"
        view="inbox"
        onAction={onAction}
        onReplyOpenChange={() => {}}
        onReplyRequest={onReplyRequest}
        onOpenCompose={onOpenCompose}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { onAction, onReplyRequest, onOpenCompose };
}
async function openMore() {
  fireEvent.keyDown(await screen.findByRole("button", { name: "More actions" }), { key: "Enter" });
  return screen.findByRole("menu");
}
const names = (menu: HTMLElement) =>
  [...menu.querySelectorAll('[role="menuitem"],[role="menuitemradio"]')].map((el) => el.textContent?.trim());

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(getThread).mockResolvedValue(THREAD);
});
afterEach(() => setDesktop(true));

describe("the conversation heading", () => {
  it("drops the reply and forward prefixes", async () => {
    renderReader();
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent(/^Lunch on Friday$/);
  });

  it("falls back when nothing is left", async () => {
    vi.mocked(getThread).mockResolvedValue({ thread_id: "t1", messages: [{ ...IN, subject: "Re:" }] });
    renderReader();
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("(no subject)");
  });
});

describe("who a message is from", () => {
  it("says You, with the address, on mail I sent", async () => {
    renderReader();
    await screen.findByRole("heading", { level: 1 });
    const mine = screen.getByText("You");
    expect(within(mine.parentElement!).getByText("hello@example.com")).toBeInTheDocument();
    expect(screen.queryByText("Alex P")).toBeNull();
    // Mail from someone else keeps their name.
    expect(screen.getByText("Alice")).toBeInTheDocument();
  });
});

describe("the desktop toolbar", () => {
  it("is one labelled toolbar: Reply, the everyday actions, and More", async () => {
    renderReader();
    const toolbar = await screen.findByRole("toolbar", { name: "Conversation actions" });
    expect(within(toolbar).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual([
      "Reply", "Archive", "Move to trash", "Mark as unread", "Snooze", "More actions",
    ]);
  });

  it("More holds reply all, forward, star, junk, summarize and the reading mode", async () => {
    const menu = await (async () => { renderReader(); return openMore(); })();
    expect(names(menu)).toEqual(["Reply all", "Forward", "Star", "Report junk", "Summarize", "Print", "Rich", "Chat"]);
  });

  it("Reply all and Forward under More do what the buttons did", async () => {
    const { onReplyRequest, onOpenCompose } = renderReader();
    fireEvent.click(within(await openMore()).getByRole("menuitem", { name: "Reply all" }));
    expect(onReplyRequest).toHaveBeenCalledWith("reply-all");
    fireEvent.click(within(await openMore()).getByRole("menuitem", { name: "Forward" }));
    expect(onOpenCompose).toHaveBeenCalledWith(expect.objectContaining({ subject: expect.stringMatching(/^Fwd:/) }));
  });

  it("Report junk under More reports the thread", async () => {
    const { onAction } = renderReader();
    fireEvent.click(within(await openMore()).getByRole("menuitem", { name: "Report junk" }));
    expect(onAction).toHaveBeenCalledWith("spam");
  });

  it("Summarize under More shows the summary where the reader can find it", async () => {
    renderReader();
    fireEvent.click(within(await openMore()).getByRole("menuitem", { name: "Summarize" }));
    await waitFor(() => expect(summarizeThread).toHaveBeenCalledWith("t1"));
    expect(await screen.findByText("They agreed on Friday.")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("AI summary");
  });

  it("in Trash and Junk the row is the way back and Delete forever, with no Report junk", async () => {
    renderReader({ view: "trash" });
    const toolbar = await screen.findByRole("toolbar");
    expect(within(toolbar).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual([
      "Reply", "Restore", "Delete forever", "More actions",
    ]);
    expect(names(await openMore())).not.toContain("Report junk");
  });
});

describe("the phone top bar", () => {
  beforeEach(() => setDesktop(false));
  const chrome = {
    leading: <button type="button">Back to list</button>,
    trailing: <button type="button">Compose</button>,
  };

  it("holds Back, the thread's actions as named icon buttons, and Compose, in that order", async () => {
    renderReader({ mobileChrome: chrome });
    await screen.findByRole("heading", { level: 1 });
    const bar = screen.getByRole("toolbar").parentElement!;
    expect(within(bar).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual([
      "Back to list", "Archive", "Move to trash", "Mark as unread", "Snooze", "More actions", "Compose",
    ]);
    // Icons only: the name comes from the label, and each is a 44px target.
    for (const b of within(screen.getByRole("toolbar")).getAllByRole("button")) {
      expect(b.textContent).toBe("");
      expect(b.className).toContain("size-11");
    }
  });

  it("leaves Reply, Reply all and Forward at the end of the thread", async () => {
    renderReader({ mobileChrome: chrome });
    await screen.findByRole("heading", { level: 1 });
    expect(within(screen.getByRole("toolbar")).queryByRole("button", { name: "Reply" })).toBeNull();
    expect(names(await openMore())).toEqual(["Star", "Report junk", "Summarize", "Print", "Rich", "Chat"]);
    expect(screen.getByRole("button", { name: "Reply all", hidden: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Forward", hidden: true })).toBeInTheDocument();
  });

  it("keeps Back while the thread is still loading, and when nothing is selected", async () => {
    vi.mocked(getThread).mockImplementation(() => new Promise(() => {}));
    renderReader({ mobileChrome: chrome });
    expect(screen.getByRole("button", { name: "Back to list" })).toBeInTheDocument();
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("is one main landmark with the bar inside it", async () => {
    renderReader({ mobileChrome: chrome });
    await screen.findByRole("heading", { level: 1 });
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(within(screen.getByRole("main")).getByRole("toolbar")).toBeInTheDocument();
  });
});
