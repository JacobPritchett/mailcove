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
