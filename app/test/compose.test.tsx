import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "../App";
import type { ThreadsResponse, ThreadListRow, ThreadResponse, Me } from "../lib/types";

// Mock the typed api client. `send` is the assertion target for this suite.
vi.mock("../lib/api", () => ({
  ApiError: class ApiError extends Error {},
  listThreads: vi.fn(),
  getCounts: vi.fn(),
  mutateThread: vi.fn(() => Promise.resolve({ ok: true })),
  mutateThreads: vi.fn(() => Promise.resolve({ ok: true, count: 0 })),
  getThread: vi.fn(),
  getMe: vi.fn(),
  getIdentities: vi.fn(() => Promise.resolve({ identities: [], defaultLocal: "hello", defaultDomain: "example.com" })),
  send: vi.fn(),
  putDraft: vi.fn(() => Promise.resolve({ ok: true })),
  deleteDraft: vi.fn(() => Promise.resolve({ ok: true })),
  listDrafts: vi.fn(() => Promise.resolve({ drafts: [] })),
  getDraft: vi.fn(),
  attachmentUrl: (id: string, name: string) => `/api/attachments/${id}/${name}`,
}));

// sonner toasts touch DOM APIs jsdom doesn't fully implement; stub them out.
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
  Toaster: () => null,
}));

import { listThreads, getCounts, getThread, getMe, send } from "../lib/api";

const ROW: ThreadListRow = {
  thread_id: "t1",
  id: "m1",
  msg_from: "Alice <alice@example.com>",
  msg_to: "hello@send.example.com",
  subject: "Hello from Alice",
  snippet: "just checking in",
  date: Date.UTC(2026, 5, 3, 16, 41),
  count: 1,
  anyUnread: 1,
  hasAttachments: 0,
  starred: 0,
  category: null,
};

const THREAD: ThreadResponse = {
  thread_id: "t1",
  messages: [
    {
      id: "m1",
      thread_id: "t1",
      direction: "in",
      folder: "inbox",
      msg_from: "Alice <alice@example.com>",
      msg_to: "hello@send.example.com",
      subject: "Hello from Alice",
      snippet: "just checking in",
      date: Date.UTC(2026, 5, 3, 16, 41),
      unread: 1,
      has_attachments: 0,
      msg_cc: null,
      message_id: "<mid-1@example.com>",
      in_reply_to: null,
      body: { text: "just checking in\nbody text", html: "", attachments: [] },
    },
  ],
};

function renderApp() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
}

const THREADS_RESP: ThreadsResponse = {
  threads: [ROW],
  unread: 1,
  user: "hello@send.example.com",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listThreads).mockResolvedValue(THREADS_RESP);
  vi.mocked(getCounts).mockResolvedValue({ inbox: 1, starred: 0, sent: 0, all: 1, trash: 0, inboxUnread: 1 });
  vi.mocked(getThread).mockResolvedValue(THREAD);
  vi.mocked(getMe).mockResolvedValue({ email: "hello@send.example.com" } as Me);
  vi.mocked(send).mockResolvedValue({ ok: true, id: "sent-1" });
});

describe("ComposeDialog", () => {
  it("opens an empty compose dialog from the Compose button", async () => {
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: /compose/i }));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("New message")).toBeInTheDocument();
    // Core fields present.
    expect(screen.getByLabelText("From local part")).toBeInTheDocument();
    expect(screen.getByLabelText("Add recipient")).toBeInTheDocument();
    expect(screen.getByLabelText("Subject")).toBeInTheDocument();
    expect(await screen.findByLabelText("Message")).toBeInTheDocument();
    // Default local-part.
    expect(screen.getByLabelText("From local part")).toHaveValue("hello");
  });

  it("calls send with the filled payload (To as an array) on submit", async () => {
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: /compose/i }));
    await screen.findByRole("dialog");

    // Typed text without a delimiter stays in the input; submit commits it to a
    // recipient chip and ships the array.
    fireEvent.change(screen.getByLabelText("Add recipient"), {
      target: { value: "bob@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Subject"), {
      target: { value: "Greetings" },
    });
    fireEvent.change(await screen.findByLabelText("Message"), {
      target: { value: "hi there" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        fromLocal: "hello",
        to: ["bob@example.com"],
        subject: "Greetings",
        text: "hi there",
      }),
    );
  });

  it("commits multiple recipients as chips and sends them all", async () => {
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: /compose/i }));
    await screen.findByRole("dialog");

    const dialog = screen.getByRole("dialog");
    const toInput = screen.getByLabelText("Add recipient");
    // A comma commits the first address to a chip; Enter commits the second.
    fireEvent.change(toInput, { target: { value: "bob@example.com," } });
    fireEvent.change(toInput, { target: { value: "Carol@Example.com" } });
    fireEvent.keyDown(toInput, { key: "Enter" });

    // Both render as chips (the second lowercased), each with a remove control.
    expect(
      within(dialog).getByLabelText("Remove bob@example.com"),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByLabelText("Remove carol@example.com"),
    ).toBeInTheDocument();

    fireEvent.change(await screen.findByLabelText("Message"), {
      target: { value: "hi all" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ["bob@example.com", "carol@example.com"],
        text: "hi all",
      }),
    );
  });

  it("Reply opens the INLINE composer (no dialog), seeded with the quoted history", async () => {
    renderApp();
    fireEvent.click(await screen.findByText("Hello from Alice"));
    // Exact name — the collapsed inline affordance is "Reply to alice@…".
    fireEvent.click(await screen.findByRole("button", { name: "Reply" }));

    const inline = await screen.findByTestId("inline-reply");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(within(inline).getByText("alice@example.com")).toBeInTheDocument();

    const body = (await within(inline).findByLabelText("Message")) as HTMLTextAreaElement;
    expect(body.value).toContain("> just checking in");
    fireEvent.change(body, { target: { value: "thanks!" } });
    fireEvent.click(within(inline).getByRole("button", { name: /^send$/i }));

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "alice@example.com",
        subject: "Re: Hello from Alice",
        text: "thanks!",
        inReplyTo: "<mid-1@example.com>",
        threadId: "t1",
      }),
    );
  });

  it("the `r` shortcut opens the inline reply; X discards it", async () => {
    renderApp();
    fireEvent.click(await screen.findByText("Hello from Alice"));
    await screen.findByTestId("inline-reply"); // collapsed affordance rendered
    fireEvent.keyDown(document, { key: "r" });
    const inline = await screen.findByTestId("inline-reply");
    expect(await within(inline).findByLabelText("Message")).toBeInTheDocument();
    fireEvent.click(within(inline).getByLabelText("Discard reply"));
    expect(screen.queryByLabelText("Message")).not.toBeInTheDocument();
  });

  it("expands the inline reply into the full composer, carrying the in-progress draft", async () => {
    renderApp();
    fireEvent.click(await screen.findByText("Hello from Alice"));
    fireEvent.click(await screen.findByRole("button", { name: "Reply" }));

    const inline = await screen.findByTestId("inline-reply");
    const body = (await within(inline).findByLabelText("Message")) as HTMLTextAreaElement;
    fireEvent.change(body, { target: { value: "work in progress" } });
    fireEvent.click(within(inline).getByLabelText("Open in full composer"));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("Remove alice@example.com")).toBeInTheDocument();
    expect(screen.getByLabelText("Subject")).toHaveValue("Re: Hello from Alice");
    const dialogBody = (await within(dialog).findByLabelText("Message")) as HTMLTextAreaElement;
    expect(dialogBody.value).toBe("work in progress");
  });

  it("does NOT send a half-typed invalid recipient on submit; surfaces an error", async () => {
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: /compose/i }));
    await screen.findByRole("dialog");

    // A trailing fragment with no delimiter ("x@y") is invalid as a full address.
    fireEvent.change(screen.getByLabelText("Add recipient"), {
      target: { value: "x@y" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/not a valid email/i);
    expect(send).not.toHaveBeenCalled();
  });

  it("blocks submit with zero recipients and prompts for one", async () => {
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: /compose/i }));
    await screen.findByRole("dialog");

    fireEvent.change(await screen.findByLabelText("Message"), {
      target: { value: "body but no recipient" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/add at least one recipient/i);
    expect(send).not.toHaveBeenCalled();
  });

  it("removes the last chip on Backspace when the input is empty", async () => {
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: /compose/i }));
    const dialog = await screen.findByRole("dialog");

    const toInput = screen.getByLabelText("Add recipient");
    fireEvent.change(toInput, { target: { value: "bob@example.com," } });
    fireEvent.change(toInput, { target: { value: "carol@example.com," } });
    expect(within(dialog).getByLabelText("Remove carol@example.com")).toBeInTheDocument();

    // Input is empty after the trailing-comma commits, so Backspace pops the last chip.
    fireEvent.keyDown(toInput, { key: "Backspace" });

    expect(within(dialog).queryByLabelText("Remove carol@example.com")).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText("Remove bob@example.com")).toBeInTheDocument();
  });
});
