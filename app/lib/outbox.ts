// Undo send. A message the user has sent is held here for a few seconds
// before it goes to the Worker, with a toast offering Undo. Module-level, not
// component state: a held message outlives the composer that wrote it (the
// dialog closes on Send, an inline reply unmounts with its thread).
//
// What keeps a held message from being lost:
//   - its draft is on the server BEFORE it is held (the composers see to
//     that), and the Worker deletes that draft itself once it has accepted the
//     message. Draft cleanup and delivery are separate operations, so a
//     surviving draft does not prove that delivery failed;
//   - when the page is hidden or unloaded every held message goes at once, on
//     a keepalive request the browser finishes after the page is gone;
//   - a keepalive body is limited to about 64 KB for the whole page, so only
//     messages that fit are ever held. Anything larger (in practice: anything
//     with a file attached) is sent straight away, as it was before this
//     existed, and gets no Undo;
//   - each held message leaves a note in localStorage until its outcome has
//     been shown, so a send whose answer nobody was there to see is checked
//     against Drafts on the next visit (see reportUnsent).
import { useSyncExternalStore } from "react";
import { toast } from "sonner";
import { send } from "@/lib/api";
import type { SendPayload } from "@/lib/types";

const DELAY_KEY = "mailcove.undo-send";
const NOTES_KEY = "mailcove.outbox";

/** The delays on offer, in seconds. 0 is off. */
export const UNDO_SEND_CHOICES = [0, 5, 10, 30] as const;
export type UndoSendSeconds = (typeof UNDO_SEND_CHOICES)[number];
export const UNDO_SEND_DEFAULT: UndoSendSeconds = 10;

/**
 * The most bytes held at once, across every held message. Browsers cap the
 * bodies of all in-flight keepalive requests of a page at 64 KiB together;
 * this leaves room for headers and for being wrong about the exact figure.
 */
export const HOLD_BUDGET_BYTES = 56_000;

const listeners = new Set<() => void>();

/** How long a sent message is held, as chosen in this browser. */
export function undoSendSeconds(): UndoSendSeconds {
  try {
    const raw = localStorage.getItem(DELAY_KEY);
    if (raw === null) return UNDO_SEND_DEFAULT;
    const n = Number(raw);
    return (UNDO_SEND_CHOICES as readonly number[]).includes(n) ? (n as UndoSendSeconds) : UNDO_SEND_DEFAULT;
  } catch {
    return UNDO_SEND_DEFAULT;
  }
}

export function setUndoSendSeconds(seconds: UndoSendSeconds): void {
  try {
    localStorage.setItem(DELAY_KEY, String(seconds));
  } catch {
    // Private mode or full storage: the choice lasts for this page only.
  }
  listeners.forEach((fn) => fn());
}

/** The setting, live, for the control that changes it. */
export function useUndoSendSeconds(): UndoSendSeconds {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    undoSendSeconds,
    () => UNDO_SEND_DEFAULT,
  );
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** The request body a held message goes out with. */
function bodyOf(payload: SendPayload, draftId: string): string {
  return JSON.stringify({ ...payload, draftId });
}

/**
 * May this message be held? Not with the delay off, and not when it could not
 * be sent from a page that is going away (see the note on keepalive above).
 */
export function canHold(payload: SendPayload): boolean {
  if (undoSendSeconds() === 0) return false;
  if (payload.attachments?.length) return false;
  // The draft id adds a few dozen bytes; 64 covers any id the app mints.
  return byteLength(JSON.stringify(payload)) + 64 <= HOLD_BUDGET_BYTES;
}

export interface HoldRequest {
  payload: SendPayload;
  /** The saved draft of this message. The Worker deletes it on acceptance. */
  draftId: string;
  /** Put the composer back as it was (Undo, and "Open draft" after a failure). */
  restore: () => void;
  /** The send has an answer, either way: refresh whatever shows mail and drafts. */
  onSettled?: () => void;
}

interface Held extends HoldRequest {
  id: string;
  body: string;
  bytes: number;
  /** held: waiting, Undo possible. sending: on its way. done: sent, failed or undone. */
  state: "held" | "sending" | "done";
  timer: ReturnType<typeof setTimeout> | null;
  toastId: string;
}

/** What survives the page: enough to check a send nobody saw the answer to. */
interface Note {
  id: string;
  draftId: string;
  to: string;
  subject: string;
  /** When the send will certainly have been attempted (epoch ms). */
  due: number;
}

const queue: Held[] = [];
let seq = 0;

function readNotes(): Note[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(NOTES_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (n): n is Note =>
        !!n && typeof n.id === "string" && typeof n.draftId === "string" &&
        typeof n.to === "string" && typeof n.subject === "string" &&
        typeof n.due === "number" && Number.isFinite(n.due),
    );
  } catch {
    return [];
  }
}

function writeNotes(notes: Note[]): void {
  try {
    if (notes.length) localStorage.setItem(NOTES_KEY, JSON.stringify(notes));
    else localStorage.removeItem(NOTES_KEY);
  } catch {
    // Without storage the next-visit check is lost; the draft itself is not.
  }
}

function dropNote(id: string): void {
  writeNotes(readNotes().filter((n) => n.id !== id));
}

function firstRecipient(to: SendPayload["to"]): string {
  const list = Array.isArray(to) ? to : to.split(",");
  const first = (list[0] ?? "").trim();
  return list.length > 1 ? `${first} and ${list.length - 1} more` : first;
}

function settle(h: Held): void {
  h.state = "done";
  const i = queue.indexOf(h);
  if (i !== -1) queue.splice(i, 1);
}

/**
 * Send a held message now. `keepalive` is for a page that is going away. Safe
 * to call twice: only a message still waiting is sent.
 */
function release(h: Held, keepalive: boolean): void {
  if (h.state !== "held") return;
  h.state = "sending";
  if (h.timer) clearTimeout(h.timer);
  h.timer = null;
  // No Undo from here on. Stays up until the outcome replaces it.
  toast.loading("Sending…", { id: h.toastId, action: undefined, duration: Infinity });
  send(JSON.parse(h.body) as SendPayload, { keepalive }).then(
    () => {
      settle(h);
      dropNote(h.id);
      toast.success("Sent ✓", { id: h.toastId, description: undefined, action: undefined, duration: 4000 });
      h.onSettled?.();
    },
    () => {
      settle(h);
      // Told now, so there is nothing left to tell on the next visit. If this
      // page is already gone the toast is never drawn, but then neither is
      // this line reached: the note stays and reportUnsent picks it up.
      dropNote(h.id);
      toast.error("Couldn’t confirm sending. Check Sent before sending again. Your saved draft can be reopened.", {
        id: h.toastId,
        duration: Infinity,
        action: { label: "Open draft", onClick: () => h.restore() },
      });
      h.onSettled?.();
    },
  );
}

function cancel(h: Held): boolean {
  if (h.state !== "held") return false;
  if (h.timer) clearTimeout(h.timer);
  h.timer = null;
  settle(h);
  dropNote(h.id);
  toast.dismiss(h.toastId);
  return true;
}

function undo(h: Held): boolean {
  if (!cancel(h)) return false;
  h.restore();
  return true;
}

/** Protect a draft being sent from being edited or deleted underneath the send. */
export function draftSendPending(draftId: string): boolean {
  return queue.some((h) => h.draftId === draftId) || readNotes().some((n) => n.draftId === draftId);
}

/** A draft may be edited/deleted only after cancelling its local, still-held send. */
export function cancelHeldDraft(draftId: string): boolean {
  for (const h of [...queue]) {
    if (h.draftId === draftId && h.state === "held") cancel(h);
  }
  return !draftSendPending(draftId);
}

/**
 * Hold a message for the chosen delay, then send it. The caller has already
 * checked canHold and saved the draft. A queue, not a slot: any number can be
 * held at once, each with its own toast and its own Undo.
 */
export function holdSend(req: HoldRequest): void {
  ensurePageListeners();
  const seconds = undoSendSeconds();
  const body = bodyOf(req.payload, req.draftId);
  const h: Held = {
    ...req,
    id: `held-${Date.now()}-${++seq}`,
    body,
    bytes: byteLength(body),
    state: "held",
    timer: null,
    toastId: `undo-send-${seq}`,
  };
  // Everything held has to fit one page's keepalive allowance, so the oldest
  // go out early (the page is here to see them through) to make room.
  for (;;) {
    const waiting = queue.filter((q) => q.state === "held");
    if (!waiting.length || waiting.reduce((n, q) => n + q.bytes, 0) + h.bytes <= HOLD_BUDGET_BYTES) break;
    release(waiting[0], false);
  }
  queue.push(h);
  writeNotes([
    ...readNotes(),
    {
      id: h.id,
      draftId: req.draftId,
      to: firstRecipient(req.payload.to),
      subject: req.payload.subject,
      due: Date.now() + seconds * 1000,
    },
  ]);
  toast("Sending…", {
    id: h.toastId,
    description: `To ${firstRecipient(req.payload.to)}`,
    // The timer below is the clock; the toast only has to outlast it.
    duration: Infinity,
    action: { label: "Undo", onClick: () => void undo(h) },
  });
  h.timer = setTimeout(() => release(h, false), seconds * 1000);
}

/** Undo the most recent message still being held (the `z` key). */
export function undoLastHeld(): boolean {
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].state === "held") return undo(queue[i]);
  }
  return false;
}

/** Send everything still held, at once. The page is hidden or going away. */
export function flushHeld(): void {
  for (const h of [...queue]) release(h, true);
}

let listening = false;
function ensurePageListeners(): void {
  if (listening || typeof document === "undefined") return;
  listening = true;
  // Hidden covers a switched tab and a phone going to its home screen, where
  // the page may never run again; pagehide covers a reload or a closed tab.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushHeld();
  });
  window.addEventListener("pagehide", flushHeld);
}

/** How long after it was due a send is given before its draft is checked. */
const SETTLE_MS = 15_000;

/**
 * On opening the app: was anything sent from an earlier page whose answer
 * nobody saw? A surviving draft is recoverable, but delivery may have succeeded
 * before draft cleanup failed. Report uncertainty, never invite a blind retry.
 * `draftIds` lists the drafts that exist now.
 */
export async function reportUnsent(
  draftIds: () => Promise<string[]>,
  openDraft: (draftId: string) => void,
  now: number = Date.now(),
): Promise<void> {
  // Not this page's own: those are still held, or being sent, right here.
  const mine = new Set(queue.map((h) => h.id));
  // Nor one still inside its delay in another tab, or sent a moment ago by a
  // page that has just gone: the Worker may not have finished with it.
  const ready = readNotes().filter((n) => !mine.has(n.id) && now >= n.due + SETTLE_MS);
  if (!ready.length) return;
  let existing: Set<string>;
  try {
    existing = new Set(await draftIds());
  } catch {
    return; // ask again on the next visit rather than guess
  }
  const readyIds = new Set(ready.map((n) => n.id));
  writeNotes(readNotes().filter((n) => !readyIds.has(n.id)));
  for (const n of ready) {
    if (!existing.has(n.draftId)) continue; // accepted: the draft is gone
    const what = n.subject.trim() ? `"${n.subject.trim()}"` : "A message";
    toast.error(`${what}${n.to ? ` to ${n.to}` : ""} still has a saved draft. Check Sent before sending again; delivery could not be confirmed.`, {
      id: `unsent-${n.id}`,
      duration: Infinity,
      action: { label: "Open draft", onClick: () => openDraft(n.draftId) },
    });
  }
}

/** The earliest time a note left by another page can be checked, or null. */
export function nextUnsentCheck(): number | null {
  const mine = new Set(queue.map((h) => h.id));
  const dues = readNotes().filter((n) => !mine.has(n.id)).map((n) => n.due + SETTLE_MS);
  return dues.length ? Math.min(...dues) : null;
}

/** Test seam: forget everything held (timers included) without sending. */
export function resetOutboxForTest(): void {
  for (const h of queue) if (h.timer) clearTimeout(h.timer);
  queue.length = 0;
}
