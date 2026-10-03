// Opening a thread from outside the app's own UI: a notification tap on an
// open window (service worker message) or a cold start at /?thread=<id>.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "../App";

vi.mock("../lib/api", () => ({
  ApiError: class ApiError extends Error {},
  listThreads: vi.fn(),
  getCounts: vi.fn(),
  mutateThread: vi.fn(() => Promise.resolve({ ok: true })),
  mutateThreads: vi.fn(() => Promise.resolve({ ok: true, count: 0 })),
  getThread: vi.fn(),
  getMe: vi.fn(() => Promise.resolve({ email: "me@example.com" })),
  getIdentities: vi.fn(() =>
    Promise.resolve({ identities: [], defaultLocal: "hello", defaultDomain: "example.com" }),
  ),
  send: vi.fn(),
  putDraft: vi.fn(() => Promise.resolve({ ok: true })),
  getDraftAttachments: vi.fn(() => Promise.resolve({ attachments: [] })),
  deleteDraft: vi.fn(() => Promise.resolve({ ok: true })),
  getContacts: vi.fn(() => Promise.resolve({ contacts: [] })),
  attachmentUrl: (id: string, name: string) => `/api/attachments/${id}/${name}`,
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  Toaster: () => null,
}));

import { listThreads, getCounts, getThread } from "../lib/api";

const thread = (id: string) => ({
  thread_id: id,
  messages: [{
    id: "m" + id, thread_id: id, direction: "in", folder: "inbox", msg_from: "Alice <alice@example.com>",
    msg_to: "me@example.com", subject: "Subj " + id, snippet: "s", date: Date.now(), unread: 0,
    has_attachments: 0, msg_cc: null, message_id: "<mid>", in_reply_to: null,
    body: { text: "hello", html: "", attachments: [] },
  }],
});

function renderApp() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><App /></QueryClientProvider>);
}

function setViewport(isDesktop: boolean) {
  window.matchMedia = ((query: string) =>
    ({
      matches: /min-width:\s*768px/.test(query) ? isDesktop : !isDesktop,
      media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
}

let sw: EventTarget;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listThreads).mockResolvedValue({ threads: [], unread: 0, user: "me" } as never);
  vi.mocked(getCounts).mockResolvedValue({ inbox: 0, starred: 0, sent: 0, all: 0, trash: 0, inboxUnread: 0 });
  vi.mocked(getThread).mockImplementation(async (id: string) => thread(id) as never);
  sw = new EventTarget();
  Object.defineProperty(navigator, "serviceWorker", { value: sw, configurable: true });
});

afterEach(() => {
  Reflect.deleteProperty(navigator, "serviceWorker");
  window.history.replaceState(null, "", "/");
  setViewport(true);
});

const swMessage = (data: unknown) =>
  act(() => {
    sw.dispatchEvent(new MessageEvent("message", { data }));
  });

describe("open-thread message from the service worker", () => {
  it("selects the thread", async () => {
    renderApp();
    await swMessage({ type: "open-thread", threadId: "t7" });
    expect(await screen.findByRole("heading", { name: "Subj t7" })).toBeInTheDocument();
  });

  it("switches the mobile view to the reader", async () => {
    setViewport(false);
    renderApp();
    await swMessage({ type: "open-thread", threadId: "t7" });
    expect(await screen.findByRole("button", { name: /back to list/i })).toBeInTheDocument();
  });

  it("leaves a compose in progress alone", async () => {
    renderApp();
    fireEvent.click(screen.getAllByRole("button", { name: /compose/i })[0]);
    const body = await screen.findByLabelText("Message");
    fireEvent.change(body, { target: { value: "half written" } });

    await swMessage({ type: "open-thread", threadId: "t7" });
    expect(await screen.findByRole("heading", { name: "Subj t7", hidden: true })).toBeInTheDocument();
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("half written");
  });

  it("ignores messages that are not a well-formed open-thread", async () => {
    renderApp();
    await swMessage({ type: "open-thread" });
    await swMessage({ type: "something-else", threadId: "t7" });
    await swMessage("open-thread");
    await swMessage(null);
    expect(getThread).not.toHaveBeenCalled();
  });
});

describe("?thread= on load", () => {
  it("selects the thread and strips the parameter without adding history", async () => {
    window.history.replaceState(null, "", "/?thread=t%209&keep=1#frag");
    const before = window.history.length;
    renderApp();
    expect(await screen.findByRole("heading", { name: "Subj t 9" })).toBeInTheDocument();
    expect(window.location.search).toBe("?keep=1");
    expect(window.location.hash).toBe("#frag");
    expect(window.history.length).toBe(before);
  });
});
