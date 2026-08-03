// Reply prefill construction, shared by the inline thread composer (Reader)
// and the full compose dialog (App keyboard/menu paths).
import { addressOf, senderLabel } from "@/lib/format";
import type { ComposeInitial } from "@/components/ComposeDialog";
import type { MessageDetail, ThreadMessage } from "@/lib/types";

/** Build reply prefill (To, Re: subject, quoted body, inReplyTo/threadId). */
export function buildReplyInitial(detail: MessageDetail): ComposeInitial {
  const { message: m, body } = detail;
  const subject = m.subject || "";
  const reSubject = /^re:/i.test(subject) ? subject : `Re: ${subject}`;
  // Gmail-style attribution: "On Jun 9, 2026 at 2:30 PM, Alice wrote:" —
  // sender display name (not the full Name <addr> form), no seconds.
  const d = new Date(m.date);
  const onDate = d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  const atTime = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  // The attribution rides INSIDE the quote block (first quoted line) so the
  // whole history renders as one muted region — and CSS never has to guess
  // which paragraph is the attribution (a user paragraph above a quote must
  // not be dimmed).
  const quoted = [`On ${onDate} at ${atTime}, ${senderLabel(m.msg_from)} wrote:`, ...(body.text || "").split("\n")]
    .map((line) => `> ${line}`)
    .join("\n");
  // Leading blank line = the empty paragraph the caret lands in (the editor
  // seed preserves it); the quoted history follows.
  const text = `\n\n${quoted}`;
  return {
    to: addressOf(m.msg_from),
    subject: reSubject,
    text,
    // Marks this prefill as a genuine reply, so a composer knows the body is
    // ours to seed a signature into (a resumed draft's body is not).
    replyQuote: text,
    inReplyTo: m.message_id ?? undefined,
    threadId: m.thread_id,
    // Reply as the identity the original mail was addressed to (multi-domain);
    // the compose picker ignores it when that domain can't send.
    fromDomain: m.domain ?? undefined,
  };
}

/**
 * The reply target for a thread: the latest INBOUND message (fallback: latest
 * message), stamped with the thread root id so the reply joins the thread.
 */
export function replyInitialForThread(
  threadRootId: string,
  messages: ThreadMessage[],
): ComposeInitial | null {
  if (messages.length === 0) return null;
  const lastInbound =
    [...messages].reverse().find((m) => m.direction === "in") ??
    messages[messages.length - 1];
  return buildReplyInitial({
    message: { ...lastInbound, thread_id: threadRootId },
    body: lastInbound.body,
  });
}

/**
 * The body a composer starts with: an empty caret paragraph, the signature,
 * then the quoted history.
 *
 * `quote` is what buildReplyInitial produced (already `\n\n` + the `>` block)
 * or "" for a new message, so the two cases share one shape and one seeding
 * path. Signature ABOVE the quote, Gmail-style: the reader's eye should reach
 * your sign-off before the history, not after it.
 */
export function bodySeedWithSignature(quote: string, signature: string): string {
  if (!signature) return quote;
  if (!quote) return `\n\n${signature}`;
  // Never butt the two together. buildReplyInitial's quote already opens with a
  // blank line, but this helper is one `initial.text` away from being handed a
  // resumed draft body, and "Example CoHi Bob," is the kind of thing that ships.
  const gap = quote.startsWith("\n") ? "" : "\n\n";
  return `\n\n${signature}${gap}${quote}`;
}

/**
 * Compare a composer body against what we seeded into it.
 *
 * The editor is not a text box: a seed goes in as plain text, becomes a TipTap
 * document (`> ` lines turn into a <blockquote>) and comes back out of
 * getText() WITHOUT the quote markers and with different blank-line runs. So
 * the mirror never equals the seed byte-for-byte for a reply, and any
 * "is this still untouched?" test that compares raw strings answers `false`
 * the moment we seed - which silently made every opened reply look edited.
 *
 * Normalising both sides through the same lossy shape is what makes the
 * comparison apples-to-apples.
 */
export function sameBody(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      // ALL leading markers, not one. buildReplyInitial prefixes "> " to every
      // line of the inbound body, so replying inside an ongoing conversation
      // seeds "> > text" while the editor's blockquote absorbs exactly one
      // level and returns "> text". Stripping one level from each leaves them
      // still unequal — which is the whole bug, alive again for every threaded
      // reply. Stripping to bare text makes the depth irrelevant.
      .replace(/^[ \t]*(?:>[ \t]?)+/gm, "")
      .replace(/\s+/g, " ")
      .trim();
  return norm(a) === norm(b);
}
