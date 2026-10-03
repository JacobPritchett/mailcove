// A last-resort local copy of an inline reply, for the one case where nothing
// else holds it: the send failed after its composer was gone AND the draft
// could not be saved either (offline). Kept per thread in localStorage and put
// back the next time that thread's reply is opened. It is cleared as soon as
// the text is safe somewhere real: sent, saved as a draft, or discarded.

const PREFIX = "mailcove.reply-stash.";

export interface StashedReply {
  text: string;
  /** Stringified editor document, "" when there was none. */
  json: string;
}

/** Returns false when the copy could not be kept (storage full or unavailable). */
export function stashReply(threadId: string, reply: StashedReply): boolean {
  try {
    localStorage.setItem(PREFIX + threadId, JSON.stringify(reply));
    return true;
  } catch {
    return false;
  }
}

export function stashedReply(threadId: string): StashedReply | null {
  try {
    const raw = localStorage.getItem(PREFIX + threadId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StashedReply> | null;
    if (typeof parsed?.text !== "string" || !parsed.text.trim()) return null;
    return { text: parsed.text, json: typeof parsed.json === "string" ? parsed.json : "" };
  } catch {
    return null;
  }
}

export function clearStashedReply(threadId: string): void {
  try {
    localStorage.removeItem(PREFIX + threadId);
  } catch {
    // nothing to clear, or nowhere to clear it from
  }
}
