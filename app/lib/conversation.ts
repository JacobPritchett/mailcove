// Who a reply goes to, who it comes from, and what a forward carries.
// Pure functions over a thread message, shared by the inline composer and the
// compose dialog so "reply all" means the same thing in both.
import { addressOf, senderLabel, splitAddressList } from "@/lib/format";
import { isValidEmail } from "@/lib/recipients";
import type { ThreadMessage } from "@/lib/types";

export type ReplyMode = "reply" | "reply-all";

export interface ReplyRecipients {
  to: string[];
  cc: string[];
}

/** Bare, lowercased-for-compare addresses from a stored header string. */
function addressesIn(raw: string | null | undefined): string[] {
  return splitAddressList(raw ?? "")
    .map((entry) => addressOf(entry).trim())
    .filter((a) => isValidEmail(a));
}

function dedupe(list: string[], exclude: Set<string>): string[] {
  const seen = new Set(exclude);
  const out: string[] = [];
  for (const a of list) {
    const key = a.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

/**
 * The address a message was delivered to, when we can name it: the envelope
 * recipient (catch-all and BCC safe), else a To/Cc address on the message's
 * own domain.
 */
export function deliveredTo(m: Pick<ThreadMessage, "envelope_to" | "msg_to" | "msg_cc" | "domain">): string | null {
  const env = (m.envelope_to || "").trim().toLowerCase();
  if (env && isValidEmail(env)) return env;
  const domain = (m.domain || "").toLowerCase();
  if (!domain) return null;
  const hit = [...addressesIn(m.msg_to), ...addressesIn(m.msg_cc)].find((a) =>
    a.toLowerCase().endsWith(`@${domain}`),
  );
  return hit ? hit.toLowerCase() : null;
}

/**
 * Recipients for a reply to `m`.
 *
 * Replying to someone else's mail goes to their Reply-To when they set one
 * (lists, contact forms, and our own send.* transport all depend on that),
 * else to From. Reply all adds everyone else on To and Cc. Replying to mail WE
 * sent follows up with the same people instead of writing to ourselves.
 * `mine` holds the user's own addresses, which are never added back. An entry
 * written "@example.com" covers every address on that domain: this inbox is a
 * single owner's catch-all, so anything on a domain it receives for is them.
 */
export function replyRecipients(m: ThreadMessage, mode: ReplyMode, mine: Iterable<string> = []): ReplyRecipients {
  const self = new Set<string>();
  for (const a of mine) if (a) self.add(a.toLowerCase());
  const delivered = deliveredTo(m);
  if (delivered) self.add(delivered);

  if (m.direction === "out") {
    const to = dedupe(addressesIn(m.msg_to), new Set());
    const cc = mode === "reply-all" ? dedupe(addressesIn(m.msg_cc), new Set(to.map((a) => a.toLowerCase()))) : [];
    return { to, cc };
  }

  const replyTo = (m.body?.headers?.replyTo ?? []).map((r) => r.address).filter((a) => isValidEmail(a));
  const from = addressOf(m.msg_from);
  const to = dedupe(replyTo.length ? replyTo : isValidEmail(from) ? [from] : [], new Set());
  if (mode === "reply") return { to, cc: [] };

  const exclude = new Set([...self, ...to.map((a) => a.toLowerCase())]);
  // The sender stays in the conversation even when Reply-To redirected `to`.
  const others = [...(replyTo.length && isValidEmail(from) ? [from] : []), ...addressesIn(m.msg_to), ...addressesIn(m.msg_cc)];
  const onOwnDomain = (a: string) => self.has(a.slice(a.lastIndexOf("@")).toLowerCase());
  return { to, cc: dedupe(others, exclude).filter((a) => !onOwnDomain(a)) };
}

/** True when reply all would reach anyone a plain reply does not. */
export function hasReplyAll(m: ThreadMessage, mine: Iterable<string> = []): boolean {
  const one = replyRecipients(m, "reply", mine);
  const all = replyRecipients(m, "reply-all", mine);
  return all.to.length + all.cc.length > one.to.length + one.cc.length;
}

function prefixed(subject: string, prefix: "Re" | "Fwd"): string {
  const s = subject || "";
  const re = prefix === "Re" ? /^re:/i : /^(fwd?|fw):/i;
  return re.test(s.trim()) ? s : `${prefix}: ${s}`;
}

export const replySubject = (subject: string) => prefixed(subject, "Re");
export const forwardSubject = (subject: string) => prefixed(subject, "Fwd");

/** A file a forward will fetch and attach. */
export interface ForwardPart {
  partId: string;
  name: string;
  type: string;
  size: number;
}

/**
 * Which of a message's files a forward carries, and which it cannot.
 *
 * Left out without comment: an image the HTML body itself displays (a part
 * marked inline AND referenced from the body by cid:). That is part of how
 * the message looks, not a file someone attached. A Content-ID alone decides
 * nothing: Outlook and Apple Mail put one on ordinary attachments too.
 *
 * Left out and named in `notStored`: files whose bytes were never kept (over
 * the per-message cap when received), which there is nothing to forward.
 */
export function forwardableParts(m: ThreadMessage): { parts: ForwardPart[]; notStored: string[] } {
  const html = m.body?.html ?? "";
  const parts: ForwardPart[] = [];
  const notStored: string[] = [];
  for (const a of m.body?.attachments ?? []) {
    const cid = (a.contentId ?? "").replace(/^<|>$/g, "");
    const shownInBody = a.disposition === "inline" && !!cid && html.includes(`cid:${cid}`);
    if (shownInBody) continue;
    if (a.stored === false || !a.partId) notStored.push(a.name);
    else parts.push({ partId: a.partId, name: a.name, type: a.mimeType, size: a.size });
  }
  return { parts, notStored };
}

/**
 * The user's own addresses for reply all, as `replyRecipients` takes them:
 * every domain this inbox receives for, written "@domain". Drawn from the
 * sending identities and from the conversation itself (an inbound message's
 * `domain` is one we received it on).
 */
export function ownDomains(identityDomains: Iterable<string>, messages: Pick<ThreadMessage, "direction" | "domain">[]): string[] {
  const out = new Set<string>();
  for (const d of identityDomains) if (d) out.add(`@${d.toLowerCase()}`);
  for (const m of messages) if (m.domain) out.add(`@${m.domain.toLowerCase()}`);
  return [...out];
}

/**
 * Body seed for a forward: an empty paragraph for the user's note, then the
 * original message under the header block every mail client uses. The text is
 * NOT quoted with ">": a forward hands the message on, it does not reply to it.
 */
export function forwardBody(m: ThreadMessage): string {
  const d = new Date(m.date);
  const when = `${d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" })} at ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  const from = m.msg_from.trim();
  const lines = [
    "---------- Forwarded message ----------",
    `From: ${senderLabel(from)}${addressOf(from) && addressOf(from) !== senderLabel(from) ? ` <${addressOf(from)}>` : ""}`,
    `Date: ${when}`,
    `Subject: ${m.subject || "(no subject)"}`,
    `To: ${m.msg_to}`,
    ...(m.msg_cc?.trim() ? [`Cc: ${m.msg_cc.trim()}`] : []),
    "",
    (m.body?.text || "").trimEnd(),
  ];
  return `\n\n${lines.join("\n")}`;
}

/**
 * A display name that itself contains an email address on a DIFFERENT domain
 * from the real sender is the classic spoof ("PayPal <service@paypal.com>"
 * <x@evil.example>). Returns the address claimed in the name, or null.
 * Mirrors src/mailHeaders.ts so the warning needs no extra stored field and
 * also covers mail received before that field existed.
 */
export function addressClaimedInName(name: string | null | undefined, address: string | null | undefined): string | null {
  const m = /[^\s@<>,;"()]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i.exec((name || "").slice(0, 500));
  if (!m) return null;
  const real = (address || "").toLowerCase();
  const realDomain = real.slice(real.lastIndexOf("@") + 1);
  if (!realDomain || m[1].toLowerCase() === realDomain) return null;
  return m[0];
}
