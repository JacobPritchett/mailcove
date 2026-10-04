// Reply prefill construction, shared by the inline thread composer (Reader)
// and the full compose dialog (App keyboard/menu paths).
import { addressOf, senderLabel } from "@/lib/format";
import {
  deliveredTo,
  forwardBody,
  forwardableParts,
  forwardSubject,
  replyRecipients,
  replySubject,
  type ReplyMode,
} from "@/lib/conversation";
import type { ComposeInitial } from "@/components/ComposeDialog";
import { baseLocal } from "@/lib/identity";
import type { MessageDetail, ThreadMessage } from "@/lib/types";

/**
 * Build reply prefill (To/Cc, Re: subject, quoted body, inReplyTo/threadId).
 * `mine` lists the user's own addresses, which reply all never adds back.
 */
export function buildReplyInitial(
  detail: MessageDetail,
  mode: ReplyMode = "reply",
  mine: Iterable<string> = [],
): ComposeInitial {
  const { message: m, body } = detail;
  const target = { ...m, body } as ThreadMessage;
  const { to, cc } = replyRecipients(target, mode, mine);
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
    to: to.join(", "),
    ...(cc.length ? { cc: cc.join(", ") } : {}),
    subject: replySubject(m.subject || ""),
    text,
    // Marks this prefill as a genuine reply, so a composer knows the body is
    // ours to seed a signature into (a resumed draft's body is not).
    replyQuote: text,
    inReplyTo: m.message_id ?? undefined,
    threadId: m.thread_id,
    ...replyIdentity(target),
  };
}

/**
 * Reply as the address the mail was actually sent to (shop@, billing@), not
 * the default one: the other side wrote to that address and expects it back.
 * A follow-up on our own sent mail keeps the address it went out from. The
 * compose picker ignores the domain when it cannot send.
 */
function replyIdentity(m: ThreadMessage): Pick<ComposeInitial, "fromDomain" | "fromLocal"> {
  const domain = (m.domain ?? "").toLowerCase();
  const own = m.direction === "out" ? addressOf(m.msg_from).toLowerCase() : deliveredTo(m);
  const at = own ? own.lastIndexOf("@") : -1;
  const sameDomain = !!own && at > 0 && own.slice(at + 1) === domain;
  // The mailbox, without a plus tag: mail to me+shop@ is answered from me@.
  // The Worker cannot send from a tagged address anyway (its sanitizer drops
  // the "+", which would make it "meshop@"), so naming one here would show a
  // From that is not the one used.
  const local = sameDomain ? baseLocal(own!.slice(0, at)) : "";
  return {
    fromDomain: m.domain ?? undefined,
    ...(local ? { fromLocal: local } : {}),
  };
}

/** The message a reply answers by default: the latest inbound, else the latest. */
export function defaultReplyTarget(messages: ThreadMessage[]): ThreadMessage | null {
  if (messages.length === 0) return null;
  return [...messages].reverse().find((m) => m.direction === "in") ?? messages[messages.length - 1];
}

/**
 * The reply prefill for a thread, stamped with the thread root id so the reply
 * joins the thread. `targetId` picks a specific message (the per-message
 * menu); otherwise the default target is used.
 */
export function replyInitialForThread(
  threadRootId: string,
  messages: ThreadMessage[],
  mode: ReplyMode = "reply",
  targetId?: string | null,
  mine: Iterable<string> = [],
): ComposeInitial | null {
  const target = (targetId && messages.find((m) => m.id === targetId)) || defaultReplyTarget(messages);
  if (!target) return null;
  const initial = buildReplyInitial({ message: { ...target, thread_id: threadRootId }, body: target.body }, mode, mine);
  // The first message we sent establishes the conversation's display name.
  // Never inherit a correspondent's name, even when replying to their message.
  for (const sent of messages.filter((m) => m.direction === "out").sort((a, b) => a.date - b.date)) {
    const storedName = sent.body.headers?.fromName;
    const label = senderLabel(sent.msg_from);
    const name = storedName || (label !== addressOf(sent.msg_from) ? label : "");
    // Older sent copies saved only the address. Use the earliest known name
    // so choosing one on a reply also repairs continuity in existing threads.
    if (name) {
      initial.fromName = name;
      break;
    }
  }
  return initial;
}

/**
 * Forward prefill: a new message (no threading headers, so it starts its own
 * conversation for the recipient) carrying the original text and a list of the
 * original's files for the composer to fetch and attach.
 */
export function forwardInitial(m: ThreadMessage): ComposeInitial {
  const { parts, notStored } = forwardableParts(m);
  return {
    subject: forwardSubject(m.subject || ""),
    text: forwardBody(m),
    // Everything in it so far is generated: closed unchanged, there is nothing
    // of the user's to keep as a draft.
    generated: true,
    ...replyIdentity(m),
    ...(parts.length || notStored.length ? { forward: { messageId: m.id, parts, notStored } } : {}),
  };
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
