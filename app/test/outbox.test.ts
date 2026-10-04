// The undo-send queue on its own: timing, Undo, the page going away, the
// keepalive budget, and the check for a send nobody saw the answer to.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../lib/api", () => ({ send: vi.fn() }));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), loading: vi.fn(), dismiss: vi.fn() }),
}));

import { toast } from "sonner";
import { send } from "../lib/api";
import {
  canHold,
  cancelHeldDraft,
  draftSendPending,
  flushHeld,
  holdSend,
  HOLD_BUDGET_BYTES,
  nextUnsentCheck,
  reportUnsent,
  resetOutboxForTest,
  setUndoSendSeconds,
  undoLastHeld,
  undoSendSeconds,
} from "../lib/outbox";

const payload = (subject = "Hi", text = "body") => ({ to: ["ada@example.com"], subject, text });
const notes = () => JSON.parse(localStorage.getItem("mailcove.outbox") ?? "[]") as { draftId: string }[];
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  localStorage.clear();
  resetOutboxForTest();
  vi.mocked(send).mockResolvedValue({ ok: true, id: "sent" });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the delay setting", () => {
  it("defaults to ten seconds and remembers a choice per browser", () => {
    expect(undoSendSeconds()).toBe(10);
    setUndoSendSeconds(30);
    expect(undoSendSeconds()).toBe(30);
    expect(localStorage.getItem("mailcove.undo-send")).toBe("30");
  });

  it("ignores a stored value that is not one of the choices", () => {
    localStorage.setItem("mailcove.undo-send", "7");
    expect(undoSendSeconds()).toBe(10);
    localStorage.setItem("mailcove.undo-send", "soon");
    expect(undoSendSeconds()).toBe(10);
  });
});

describe("canHold", () => {
  it("holds an ordinary message", () => {
    expect(canHold(payload())).toBe(true);
  });

  it("does not hold with the delay off", () => {
    setUndoSendSeconds(0);
    expect(canHold(payload())).toBe(false);
  });

  it("does not hold a message with a file, or one too large for a keepalive request", () => {
    expect(canHold({ ...payload(), attachments: [{ filename: "a.txt", type: "text/plain", data: "aGk=" }] })).toBe(false);
    expect(canHold(payload("Hi", "x".repeat(HOLD_BUDGET_BYTES)))).toBe(false);
    // Bytes, not characters: this is under the limit counted as characters.
    expect(canHold(payload("Hi", "é".repeat(HOLD_BUDGET_BYTES / 2)))).toBe(false);
  });
});

describe("holdSend", () => {
  it("sends after the delay, with the draft id so the Worker can delete it", async () => {
    const onSettled = vi.fn();
    holdSend({ payload: payload(), draftId: "draft-0001", restore: vi.fn(), onSettled });
    expect(toast).toHaveBeenCalledWith("Sending…", expect.objectContaining({ action: expect.objectContaining({ label: "Undo" }) }));
    vi.advanceTimersByTime(9_999);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ subject: "Hi", draftId: "draft-0001" }), { keepalive: false });
    await flush();
    expect(toast.success).toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(notes()).toEqual([]);
  });

  it("follows the chosen delay", () => {
    setUndoSendSeconds(5);
    holdSend({ payload: payload(), draftId: "draft-0001", restore: vi.fn() });
    vi.advanceTimersByTime(5_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("Undo puts the composer back and nothing is sent, then or later", () => {
    const restore = vi.fn();
    holdSend({ payload: payload(), draftId: "draft-0001", restore });
    const undo = vi.mocked(toast).mock.calls[0][1]!.action as unknown as { onClick: () => void };
    undo.onClick();
    undo.onClick(); // a second press is a no-op
    expect(restore).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(send).not.toHaveBeenCalled();
    expect(notes()).toEqual([]);
  });

  it("Undo after the message has gone does nothing", async () => {
    const restore = vi.fn();
    holdSend({ payload: payload(), draftId: "draft-0001", restore });
    const undo = vi.mocked(toast).mock.calls[0][1]!.action as unknown as { onClick: () => void };
    vi.advanceTimersByTime(10_000);
    undo.onClick();
    await flush();
    expect(restore).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("is a queue: a second message is held beside the first, and each sends once", async () => {
    holdSend({ payload: payload("One"), draftId: "draft-0001", restore: vi.fn() });
    vi.advanceTimersByTime(4_000);
    holdSend({ payload: payload("Two"), draftId: "draft-0002", restore: vi.fn() });
    vi.advanceTimersByTime(6_000);
    expect(vi.mocked(send).mock.calls.map((c) => c[0].subject)).toEqual(["One"]);
    vi.advanceTimersByTime(4_000);
    expect(vi.mocked(send).mock.calls.map((c) => c[0].subject)).toEqual(["One", "Two"]);
    await flush();
    vi.advanceTimersByTime(60_000);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("undoLastHeld takes back the newest held message only", () => {
    const first = vi.fn();
    const second = vi.fn();
    holdSend({ payload: payload("One"), draftId: "draft-0001", restore: first });
    holdSend({ payload: payload("Two"), draftId: "draft-0002", restore: second });
    expect(undoLastHeld()).toBe(true);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(vi.mocked(send).mock.calls.map((c) => c[0].subject)).toEqual(["One"]);
    expect(undoLastHeld()).toBe(false);
  });

  it("a failed send says the message is in Drafts and offers to open it", async () => {
    vi.mocked(send).mockRejectedValue(new Error("502"));
    const restore = vi.fn();
    holdSend({ payload: payload(), draftId: "draft-0001", restore });
    vi.advanceTimersByTime(10_000);
    await flush();
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn’t confirm sending. Check Sent before sending again. Your saved draft can be reopened.",
      expect.objectContaining({ duration: Infinity }),
    );
    const open = vi.mocked(toast.error).mock.calls[0][1]!.action as unknown as { onClick: () => void };
    open.onClick();
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it("sends the oldest early when the held messages would outgrow one keepalive allowance", () => {
    const big = "x".repeat(30_000);
    holdSend({ payload: payload("One", big), draftId: "draft-0001", restore: vi.fn() });
    expect(send).not.toHaveBeenCalled();
    holdSend({ payload: payload("Two", big), draftId: "draft-0002", restore: vi.fn() });
    // "One" went at once, on an ordinary request (the page is still here).
    expect(vi.mocked(send).mock.calls.map((c) => [c[0].subject, c[1]])).toEqual([["One", { keepalive: false }]]);
  });
});

describe("the page going away", () => {
  it("sends everything held at once, on keepalive requests", () => {
    holdSend({ payload: payload("One"), draftId: "draft-0001", restore: vi.fn() });
    holdSend({ payload: payload("Two"), draftId: "draft-0002", restore: vi.fn() });
    window.dispatchEvent(new Event("pagehide"));
    expect(vi.mocked(send).mock.calls.map((c) => [c[0].subject, c[1]])).toEqual([
      ["One", { keepalive: true }],
      ["Two", { keepalive: true }],
    ]);
    // The timers are spent: nothing goes twice.
    vi.advanceTimersByTime(60_000);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("does the same when the page is hidden", () => {
    holdSend({ payload: payload(), draftId: "draft-0001", restore: vi.fn() });
    const state = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    state.mockRestore();
    expect(send).toHaveBeenCalledWith(expect.anything(), { keepalive: true });
  });

  it("flushHeld with nothing held does nothing", () => {
    flushHeld();
    expect(send).not.toHaveBeenCalled();
  });
});

describe("reportUnsent (the next visit)", () => {
  const leaveNote = (draftId: string, due: number, subject = "Quarterly numbers") =>
    localStorage.setItem(
      "mailcove.outbox",
      JSON.stringify([...notes(), { id: `old-${draftId}`, draftId, to: "ada@example.com", subject, due }]),
    );

  it("tells the user about a message whose draft is still there", async () => {
    leaveNote("draft-0001", 1_000);
    const open = vi.fn();
    await reportUnsent(async () => ["draft-0001"], open, 100_000);
    expect(toast.error).toHaveBeenCalledWith(
      '"Quarterly numbers" to ada@example.com still has a saved draft. Check Sent before sending again; delivery could not be confirmed.',
      expect.objectContaining({ duration: Infinity }),
    );
    (vi.mocked(toast.error).mock.calls[0][1]!.action as unknown as { onClick: () => void }).onClick();
    expect(open).toHaveBeenCalledWith("draft-0001");
    // Told once.
    expect(notes()).toEqual([]);
  });

  it("says nothing when the draft is gone: the Worker accepted the message", async () => {
    leaveNote("draft-0001", 1_000);
    await reportUnsent(async () => [], vi.fn(), 100_000);
    expect(toast.error).not.toHaveBeenCalled();
    expect(notes()).toEqual([]);
  });

  it("waits for a send that may still be in flight", async () => {
    leaveNote("draft-0001", 95_000);
    const drafts = vi.fn(async () => ["draft-0001"]);
    await reportUnsent(drafts, vi.fn(), 100_000);
    expect(drafts).not.toHaveBeenCalled();
    expect(notes()).toHaveLength(1);
    expect(nextUnsentCheck()).toBe(95_000 + 15_000);
  });

  it("keeps the note when Drafts cannot be read, to ask again next time", async () => {
    leaveNote("draft-0001", 1_000);
    await reportUnsent(async () => Promise.reject(new Error("offline")), vi.fn(), 100_000);
    expect(toast.error).not.toHaveBeenCalled();
    expect(notes()).toHaveLength(1);
  });

  it("leaves this page's own held messages alone", async () => {
    holdSend({ payload: payload(), draftId: "draft-0001", restore: vi.fn() });
    const drafts = vi.fn(async () => ["draft-0001"]);
    await reportUnsent(drafts, vi.fn(), Date.now() + 3_600_000);
    expect(drafts).not.toHaveBeenCalled();
    expect(nextUnsentCheck()).toBeNull();
  });

  it("survives a corrupt note", async () => {
    localStorage.setItem("mailcove.outbox", "{not json");
    await expect(reportUnsent(async () => [], vi.fn(), 100_000)).resolves.toBeUndefined();
  });
});


describe("draft ownership while sending", () => {
  it("cancels a held draft before editing or deleting it, without reopening a composer", () => {
    const restore = vi.fn();
    holdSend({ payload: payload(), draftId: "draft-0001", restore });
    expect(draftSendPending("draft-0001")).toBe(true);
    expect(cancelHeldDraft("draft-0001")).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(send).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
    expect(draftSendPending("draft-0001")).toBe(false);
  });

  it("refuses to release a draft whose send is already in flight", async () => {
    let finish!: () => void;
    vi.mocked(send).mockImplementation(() => new Promise((resolve) => {
      finish = () => resolve({ ok: true, id: "sent" });
    }));
    holdSend({ payload: payload(), draftId: "draft-0001", restore: vi.fn() });
    flushHeld();
    expect(cancelHeldDraft("draft-0001")).toBe(false);
    finish();
    await flush();
    expect(cancelHeldDraft("draft-0001")).toBe(true);
  });

  it("does not cancel a send owned by another tab", () => {
    localStorage.setItem("mailcove.outbox", JSON.stringify([
      { id: "another-tab", draftId: "draft-0001", due: Date.now(), to: "ada@example.com", subject: "Hi" },
    ]));
    expect(cancelHeldDraft("draft-0001")).toBe(false);
  });

  it("ignores malformed notes instead of crashing recovery", async () => {
    localStorage.setItem("mailcove.outbox", JSON.stringify([
      null, { id: "bad", draftId: "draft-0001", due: 1, subject: null },
    ]));
    await expect(reportUnsent(async () => ["draft-0001"], vi.fn(), 100_000)).resolves.toBeUndefined();
    expect(toast.error).not.toHaveBeenCalled();
  });
});
