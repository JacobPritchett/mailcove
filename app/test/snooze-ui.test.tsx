/**
 * Snooze in the UI: the menu and its custom time, the shortcut, the toast and
 * its Undo, and the Snoozed view.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "../App";
import MessageList from "../components/MessageList";
import BulkActionBar from "../components/BulkActionBar";
import Reader from "../components/Reader";
import SnoozeMenu from "../components/SnoozeMenu";
import { snoozePresets, toDateTimeInputValue } from "../lib/snooze";
import type { ThreadListRow, ThreadResponse } from "../lib/types";

vi.mock("../lib/api", () => ({
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
  listThreads: vi.fn(),
  getCounts: vi.fn(),
  mutateThread: vi.fn(() => Promise.resolve({ ok: true })),
  mutateThreads: vi.fn(() => Promise.resolve({ ok: true, count: 0 })),
  getThread: vi.fn(),
  getMe: vi.fn(() => Promise.resolve({ email: "me@example.com" })),
  getIdentities: vi.fn(() => Promise.resolve({ identities: [], defaultLocal: "hello", defaultDomain: "example.com" })),
  attachmentUrl: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), dismiss: vi.fn() }),
  Toaster: () => null,
}));

import { ApiError, listThreads, getCounts, getThread, mutateThread, mutateThreads } from "../lib/api";
import { toast } from "sonner";

// Wednesday 14 October 2026, 10:15 local. Only Date is faked: the app's real
// timers (debounce, query scheduling) keep running.
const NOW = new Date(2026, 9, 14, 10, 15, 0, 0);
const at = (id: string) => snoozePresets(NOW).find((p) => p.id === id)!.at;

const ROW: ThreadListRow = {
  thread_id: "t1", id: "m1", msg_from: "Alice <alice@example.com>", msg_to: "me@example.com",
  subject: "Quarterly numbers", snippet: "see attached", date: NOW.getTime() - 60_000, count: 1, anyUnread: 0,
  hasAttachments: 0, starred: 0, category: null,
};
const THREAD: ThreadResponse = {
  thread_id: "t1",
  messages: [{
    id: "m1", thread_id: "t1", direction: "in", folder: "inbox", msg_from: "Alice <alice@example.com>",
    from_addr: "alice@example.com", msg_to: "me@example.com", subject: "Quarterly numbers",
    snippet: "see attached", date: NOW.getTime() - 60_000, unread: 0, has_attachments: 0, state: "inbox",
    body: { text: "see attached", html: "", attachments: [] },
  }],
};

function makeQc() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}
function withClient(ui: React.ReactNode) {
  return render(<QueryClientProvider client={makeQc()}>{ui}</QueryClientProvider>);
}
type ToastOpts = { action?: { label: string; onClick(): void } };
const toastFor = (label: string) =>
  vi.mocked(toast).mock.calls.find(([l]) => l === label)?.[1] as unknown as ToastOpts | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.mocked(listThreads).mockResolvedValue({ threads: [ROW], unread: 0, user: "me" });
  vi.mocked(getCounts).mockResolvedValue({ inbox: 1, starred: 0, sent: 0, all: 1, trash: 0, inboxUnread: 0 });
  vi.mocked(getThread).mockResolvedValue(THREAD);
});
afterEach(() => {
  vi.useRealTimers();
});

function renderMenu(onSnooze = vi.fn()) {
  render(
    <SnoozeMenu onSnooze={onSnooze}>
      <button type="button">Snooze</button>
    </SnoozeMenu>,
  );
  fireEvent.keyDown(screen.getByRole("button", { name: "Snooze" }), { key: "Enter" });
  return onSnooze;
}

describe("the snooze menu", () => {
  it("lists the presets, each with the day and time it resolves to", async () => {
    renderMenu();
    const menu = await screen.findByRole("menu");
    const items = within(menu).getAllByRole("menuitem").map((el) => el.textContent?.trim());
    expect(items).toEqual([
      "Later today1:15 pm",
      "TomorrowThu 8:00 am",
      "This weekendSat 8:00 am",
      "Next weekMon 8:00 am",
      "Pick a date and time",
    ]);
  });

  it("picking a preset snoozes until that time", async () => {
    const onSnooze = renderMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: /Tomorrow/ }));
    expect(onSnooze).toHaveBeenCalledWith(at("tomorrow"));
  });

  it("leaves out what does not apply: late on a Saturday there is no Later today or This weekend", async () => {
    vi.setSystemTime(new Date(2026, 9, 17, 21, 30));
    renderMenu();
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((el) => el.textContent?.trim())).toEqual([
      "TomorrowSun 8:00 am",
      "Next weekMon 8:00 am",
      "Pick a date and time",
    ]);
  });

  it("works the times out again each time it opens", async () => {
    renderMenu();
    expect(await screen.findByRole("menuitem", { name: /Later today/ })).toHaveTextContent("1:15 pm");
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    vi.setSystemTime(new Date(2026, 9, 14, 11, 40));
    fireEvent.keyDown(screen.getByRole("button", { name: "Snooze" }), { key: "Enter" });
    expect(await screen.findByRole("menuitem", { name: /Later today/ })).toHaveTextContent("2:40 pm");
  });
});

describe("a custom snooze time", () => {
  async function openPicker(onSnooze = vi.fn()) {
    renderMenu(onSnooze);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Pick a date and time" }));
    const dialog = await screen.findByRole("dialog");
    return { onSnooze, dialog, field: within(dialog).getByLabelText("Date and time") as HTMLInputElement };
  }

  it("is a native date and time field that only accepts the future, starting on tomorrow morning", async () => {
    const { field } = await openPicker();
    expect(field.type).toBe("datetime-local");
    expect(field.min).toBe("2026-10-14T10:16");
    expect(field.max).toBe("2027-10-14T10:15");
    expect(field.value).toBe(toDateTimeInputValue(at("tomorrow")));
  });

  it("snoozes until the chosen local time and closes", async () => {
    const { onSnooze, dialog, field } = await openPicker();
    fireEvent.change(field, { target: { value: "2026-11-02T09:30" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Snooze" }));
    expect(onSnooze).toHaveBeenCalledWith(new Date(2026, 10, 2, 9, 30).getTime());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("refuses a past time with a message tied to the field, and stays open", async () => {
    const { onSnooze, dialog, field } = await openPicker();
    fireEvent.change(field, { target: { value: "2026-10-14T09:00" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Snooze" }));
    const alert = within(dialog).getByRole("alert");
    expect(alert).toHaveTextContent("Pick a time in the future.");
    expect(field).toHaveAttribute("aria-describedby", alert.id);
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(onSnooze).not.toHaveBeenCalled();
  });

  it("Cancel closes without snoozing", async () => {
    const { onSnooze, dialog } = await openPicker();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onSnooze).not.toHaveBeenCalled();
  });
});

describe("snoozing a thread", () => {
  it("b opens the menu for the open thread; a preset snoozes it with a toast and Undo", async () => {
    withClient(<App />);
    await screen.findByText("Quarterly numbers");
    fireEvent.keyDown(document, { key: "j" });
    await screen.findByRole("button", { name: "Snooze" });
    fireEvent.keyDown(document, { key: "b" });

    fireEvent.click(await screen.findByRole("menuitem", { name: /Tomorrow/ }));
    await waitFor(() => expect(mutateThread).toHaveBeenCalledWith("t1", "snooze", at("tomorrow")));
    const opts = toastFor("Snoozed until Thu 8:00 am");
    expect(opts?.action?.label).toBe("Undo");

    opts!.action!.onClick();
    await waitFor(() => expect(mutateThread).toHaveBeenCalledWith("t1", "unsnooze"));
  });

  it("b does nothing with no thread open", async () => {
    withClient(<App />);
    await screen.findByText("Quarterly numbers");
    fireEvent.keyDown(document, { key: "b" });
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("a letter typed while the menu is open is not a mail command", async () => {
    withClient(<App />);
    await screen.findByText("Quarterly numbers");
    fireEvent.keyDown(document, { key: "j" });
    await screen.findByRole("button", { name: "Snooze" });
    fireEvent.keyDown(document, { key: "b" });
    const menu = await screen.findByRole("menu");
    fireEvent.keyDown(menu, { key: "e" });
    await new Promise((r) => setTimeout(r, 10));
    expect(mutateThread).not.toHaveBeenCalledWith("t1", "archive");
  });

  it("the bulk bar snoozes the selection and says how many", async () => {
    vi.mocked(listThreads).mockResolvedValue({
      threads: [ROW, { ...ROW, thread_id: "t2", subject: "Second" }], unread: 0, user: "me",
    });
    withClient(<App />);
    await screen.findByText("Second");
    fireEvent.keyDown(document, { key: "*" });
    fireEvent.keyDown(document, { key: "a" });
    fireEvent.keyDown(await screen.findByRole("button", { name: "Snooze selected" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: /Next week/ }));
    await waitFor(() => expect(mutateThreads).toHaveBeenCalledWith(["t1", "t2"], "snooze", at("next-week")));
    expect(toastFor("2 snoozed until Mon 8:00 am")).toBeDefined();
  });

  it("is offered on rows wherever it could apply, and not in Sent or Trash", async () => {
    for (const view of ["inbox", "all", "starred"] as const) {
      const { unmount } = withClient(<MessageList view={view} selectedThreadId={null} onSelect={() => {}} />);
      expect(await screen.findByRole("button", { name: "Snooze" })).toBeInTheDocument();
      unmount();
    }
    for (const view of ["sent", "trash"] as const) {
      const { unmount } = withClient(<MessageList view={view} selectedThreadId={null} onSelect={() => {}} />);
      await screen.findByText("Quarterly numbers");
      expect(screen.queryByRole("button", { name: "Snooze" })).toBeNull();
      unmount();
    }
  });

  it("passes on the Worker's reason when a snooze is refused", async () => {
    vi.mocked(mutateThread).mockRejectedValueOnce(
      new ApiError(400, "only mail in the inbox can be snoozed"),
    );
    withClient(<MessageList view="all" selectedThreadId={null} onSelect={() => {}} />);
    fireEvent.keyDown(await screen.findByRole("button", { name: "Snooze" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: /Tomorrow/ }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Couldn't snooze: only mail in the inbox can be snoozed.",
        expect.anything(),
      ),
    );
  });

  it("the reader offers it for a thread that is in the inbox, whatever the view, and not for an archived one", async () => {
    const { unmount } = withClient(<Reader threadId="t1" view="all" onAction={() => {}} />);
    expect(await screen.findByRole("button", { name: "Snooze" })).toBeInTheDocument();
    unmount();
    vi.mocked(getThread).mockResolvedValue({
      thread_id: "t1", messages: [{ ...THREAD.messages[0], state: "archived" }],
    });
    withClient(<Reader threadId="t1" view="all" onAction={() => {}} />);
    await screen.findByRole("button", { name: "Archive" });
    expect(screen.queryByRole("button", { name: "Snooze" })).toBeNull();
  });
});

describe("the Snoozed view", () => {
  const until = new Date(2026, 9, 20, 8, 0).getTime(); // the Tuesday after
  const SNOOZED: ThreadListRow = { ...ROW, snoozedUntil: until };

  beforeEach(() => {
    vi.mocked(listThreads).mockResolvedValue({ threads: [SNOOZED], unread: 0, user: "me" });
    vi.mocked(getCounts).mockResolvedValue({
      inbox: 0, starred: 0, sent: 0, all: 1, trash: 0, snoozed: 1, inboxUnread: 0,
    });
  });

  it("is in the sidebar with a plain count", async () => {
    withClient(<App />);
    const nav = await screen.findByRole("button", { name: /^Snoozed\s*1$/ });
    expect(within(nav).getByText("1")).not.toHaveAttribute("data-slot", "badge");
    fireEvent.click(nav);
    await waitFor(() => expect(listThreads).toHaveBeenCalledWith(expect.objectContaining({ view: "snoozed" })));
  });

  it("rows say when the thread comes back, in place of the date", async () => {
    withClient(<MessageList view="snoozed" selectedThreadId={null} onSelect={() => {}} />);
    expect(await screen.findByText("Until Tue 8:00 am")).toBeInTheDocument();
  });

  it("the row action is Unsnooze, and it carries the time so Undo can restore it", async () => {
    const onAction = vi.fn();
    withClient(<MessageList view="snoozed" selectedThreadId={null} onSelect={() => {}} onAction={onAction} />);
    fireEvent.click(await screen.findByRole("button", { name: "Unsnooze" }));
    expect(onAction).toHaveBeenCalledWith(["t1"], "unsnooze", { undoUntil: until });
    expect(screen.queryByRole("button", { name: "Snooze" })).toBeNull();
  });

  it("undoing an unsnooze snoozes again until the same time", async () => {
    withClient(<MessageList view="snoozed" selectedThreadId={null} onSelect={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Unsnooze" }));
    await waitFor(() => expect(mutateThread).toHaveBeenCalledWith("t1", "unsnooze"));
    toastFor("Unsnoozed")!.action!.onClick();
    await waitFor(() => expect(mutateThread).toHaveBeenCalledWith("t1", "snooze", until));
  });

  it("offers no Undo when the snooze time is unknown or already past", async () => {
    vi.mocked(listThreads).mockResolvedValue({
      threads: [{ ...SNOOZED, snoozedUntil: NOW.getTime() - 1 }], unread: 0, user: "me",
    });
    withClient(<MessageList view="snoozed" selectedThreadId={null} onSelect={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Unsnooze" }));
    await waitFor(() => expect(mutateThread).toHaveBeenCalledWith("t1", "unsnooze"));
    expect(toastFor("Unsnoozed")?.action).toBeUndefined();
  });

  it("the reader and the bulk bar offer Unsnooze there", async () => {
    const onAction = vi.fn();
    withClient(<Reader threadId="t1" view="snoozed" onAction={onAction} />);
    fireEvent.click(await screen.findByRole("button", { name: "Unsnooze" }));
    expect(onAction).toHaveBeenCalledWith("unsnooze");

    const onBulk = vi.fn();
    render(<BulkActionBar count={1} view="snoozed" onAction={onBulk} onClear={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Unsnooze selected" }));
    expect(onBulk).toHaveBeenCalledWith("unsnooze");
  });

  it("says so when nothing is snoozed", async () => {
    vi.mocked(listThreads).mockResolvedValue({ threads: [], unread: 0, user: "me" });
    withClient(<MessageList view="snoozed" selectedThreadId={null} onSelect={() => {}} />);
    expect(await screen.findByText("Nothing is snoozed")).toBeInTheDocument();
  });
});

describe("a snoozed or junk thread opened from anywhere", () => {
  const until = new Date(2026, 9, 20, 8, 0).getTime();

  it("says it is snoozed and offers Unsnooze, with the time so Undo can restore it", async () => {
    vi.mocked(getThread).mockResolvedValue({
      thread_id: "t1", messages: [{ ...THREAD.messages[0], snoozed_until: until }],
    });
    const onAction = vi.fn();
    withClient(<Reader threadId="t1" view="all" onAction={onAction} />);
    expect(await screen.findByText("Snoozed until Tue 8:00 am")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Snooze" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Unsnooze" }));
    expect(onAction).toHaveBeenCalledWith("unsnooze", { undoUntil: until });
  });

  it("treats a snooze whose time has passed as not snoozed", async () => {
    vi.mocked(getThread).mockResolvedValue({
      thread_id: "t1", messages: [{ ...THREAD.messages[0], snoozed_until: NOW.getTime() - 1 }],
    });
    withClient(<Reader threadId="t1" view="inbox" onAction={() => {}} />);
    expect(await screen.findByRole("button", { name: "Snooze" })).toBeInTheDocument();
    expect(screen.queryByText(/Snoozed until/)).toBeNull();
  });

  it("shows the Junk actions for a junk thread found by search", async () => {
    vi.mocked(getThread).mockResolvedValue({
      thread_id: "t1", messages: [{ ...THREAD.messages[0], state: "trash", spam: 1 }],
    });
    const onAction = vi.fn();
    withClient(<Reader threadId="t1" view="all" onAction={onAction} />);
    fireEvent.click(await screen.findByRole("button", { name: "Not junk" }));
    expect(onAction).toHaveBeenCalledWith("unspam");
    expect(screen.getByRole("button", { name: "Delete forever" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Snooze" })).toBeNull();
  });

  it("shows the Trash actions for a trashed thread found by search", async () => {
    vi.mocked(getThread).mockResolvedValue({
      thread_id: "t1", messages: [{ ...THREAD.messages[0], state: "trash", spam: 0 }],
    });
    withClient(<Reader threadId="t1" view="all" onAction={() => {}} />);
    expect(await screen.findByRole("button", { name: "Restore" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
  });
});
