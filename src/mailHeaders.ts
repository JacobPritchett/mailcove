// What we keep from an inbound message's headers beyond the columns in D1.
// Stored inside parsed/<id>.json (`headers`), so it reaches the reader with the
// body and needs no migration. Every value here is sender-controlled: parse
// defensively, bound everything, and never trust it for more than display or
// for an action the user explicitly triggers.

import { sanitizeMessageId } from "./threading";
import { trustedAuthVerdicts, type AuthVerdict } from "./authResults";

export type { AuthVerdict };

export interface MailboxRef {
  name: string;
  address: string;
}


export interface UnsubscribeInfo {
  /** https endpoint from List-Unsubscribe, when present and well-formed. */
  url?: string;
  /** mailto: target from List-Unsubscribe. */
  mailto?: { address: string; subject: string };
  /** RFC 8058: the https endpoint accepts a one-click POST. */
  oneClick: boolean;
}

export interface StoredHeaders {
  messageId: string;
  inReplyTo: string;
  /** Ancestor chain, oldest first, sanitized. Lets a reply send full References. */
  references?: string[];
  /** Where the sender wants replies to go, when it differs from From. */
  replyTo?: MailboxRef[];
  /** To and Cc with display names (the D1 columns keep bare addresses). */
  to?: MailboxRef[];
  cc?: MailboxRef[];
  /** Only ever set on our own sent copy: Bcc is not a header on the wire. */
  bcc?: MailboxRef[];
  unsubscribe?: UnsubscribeInfo;
  auth?: { spf: AuthVerdict; dkim: AuthVerdict; dmarc: AuthVerdict };
}

const MAX_REFERENCES = 30;
/** Longest single Message-ID kept; real ones are well under 200 characters. */
const MAX_REFERENCE_ID = 250;
/** Longest References header we will send (RFC 5322 caps a line at 998). */
const MAX_REFERENCES_HEADER = 2000;
const MAX_MAILBOXES = 100;
const MAX_NAME = 200;
const MAX_URL = 2000;
const SIMPLE_ADDRESS = /^[^\s@<>,;"()\u0000-\u001f\u007f]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

type ParsedMailbox = { name?: string | null; address?: string | null; group?: ParsedMailbox[] | null };

/** Flatten postal-mime address objects (incl. RFC 5322 groups) to usable mailboxes. */
export function mailboxes(list: ParsedMailbox[] | ParsedMailbox | null | undefined): MailboxRef[] {
  const out: MailboxRef[] = [];
  const visit = (a: ParsedMailbox | null | undefined) => {
    if (!a || out.length >= MAX_MAILBOXES) return;
    if (Array.isArray(a.group)) {
      for (const g of a.group) visit(g);
      return;
    }
    const address = (a.address || "").trim();
    if (!SIMPLE_ADDRESS.test(address)) return;
    out.push({ name: (a.name || "").trim().slice(0, MAX_NAME), address });
  };
  for (const a of Array.isArray(list) ? list : [list]) visit(a);
  return out;
}

/** References as a sanitized id list, newest MAX_REFERENCES kept (root always kept). */
export function referenceChain(references: string | string[] | null | undefined): string[] {
  const tokens = (Array.isArray(references) ? references : [references || ""])
    .flatMap((r) => String(r).slice(0, 20_000).split(/\s+/))
    .map((t) => sanitizeMessageId(t))
    // An over-long id is not a real Message-ID, and one such token would make
    // every reply in the thread carry an unsendable header.
    .filter((t): t is string => t !== null && t.length <= MAX_REFERENCE_ID);
  const unique = [...new Set(tokens)];
  if (unique.length <= MAX_REFERENCES) return unique;
  // Keep the root (it is the thread key) plus the most recent ancestors.
  return [unique[0], ...unique.slice(unique.length - (MAX_REFERENCES - 1))];
}

/**
 * The References header for a reply to `parent`: the parent's own chain plus
 * the parent itself (RFC 5322 section 3.6.4), bounded so the header stays well
 * under line-length limits however long the conversation runs.
 */
export function referencesForReply(parentChain: string[] | undefined, parentId: string): string {
  const chain = referenceChain([...(parentChain || []), parentId]);
  // Trim from the middle until it fits: the root is the thread key and the
  // newest ids are what a client matches on, so those are the ones to keep.
  while (chain.length > 2 && chain.join(" ").length > MAX_REFERENCES_HEADER) chain.splice(1, 1);
  return chain.join(" ");
}

/**
 * Parse List-Unsubscribe (RFC 2369) and List-Unsubscribe-Post (RFC 8058).
 * Only https and mailto targets are kept; anything else is ignored.
 */
export function parseListUnsubscribe(
  value: string | null | undefined,
  post: string | null | undefined,
): UnsubscribeInfo | undefined {
  if (!value) return undefined;
  let url: string | undefined;
  let mailto: UnsubscribeInfo["mailto"];
  // Entries are <uri>, comma-separated. Bounded: the header is sender text.
  const entries = value.slice(0, 8000).match(/<[^<>]{1,2100}>/g) || [];
  for (const entry of entries.slice(0, 10)) {
    const uri = entry.slice(1, -1).trim();
    if (!url && /^https:\/\//i.test(uri) && uri.length <= MAX_URL) {
      try {
        const u = new URL(uri);
        if (u.protocol === "https:" && !u.username && !u.password) url = u.toString();
      } catch {
        // Malformed URL: skip it.
      }
    } else if (!mailto && /^mailto:/i.test(uri)) {
      const [addrPart, query = ""] = uri.slice("mailto:".length).split("?", 2);
      let address = "";
      try {
        address = decodeURIComponent(addrPart).trim();
      } catch {
        address = "";
      }
      if (SIMPLE_ADDRESS.test(address)) {
        let subject = "unsubscribe";
        for (const pair of query.split("&")) {
          const [k, v = ""] = pair.split("=", 2);
          if (k.toLowerCase() === "subject") {
            try {
              // Header-bound text: drop anything that could break out of it.
              // This becomes the subject of mail WE send to an address the
              // list chose, so keep it to the token-like text real lists use
              // ("unsubscribe", an id) and nothing that reads as a message.
              const s = decodeURIComponent(v).replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
              if (/^[A-Za-z0-9 ._:@=+\-]{1,120}$/.test(s) && !/\s\S+\s\S+\s\S+\s/.test(s)) subject = s;
            } catch {
              // Keep the default subject.
            }
          }
        }
        mailto = { address, subject };
      }
    }
  }
  if (!url && !mailto) return undefined;
  const oneClick = !!url && /\bList-Unsubscribe\s*=\s*One-Click\b/i.test(post || "");
  return { ...(url ? { url } : {}), ...(mailto ? { mailto } : {}), oneClick };
}

/**
 * A display name that itself contains an email address on a DIFFERENT domain
 * from the real sender is the classic spoof ("PayPal <service@paypal.com>"
 * <x@evil.example>). Returns the address claimed in the name, or null.
 */
export function addressClaimedInName(name: string | null | undefined, address: string | null | undefined): string | null {
  const n = (name || "").slice(0, 500);
  const m = /[^\s@<>,;"()]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i.exec(n);
  if (!m) return null;
  const real = (address || "").toLowerCase();
  const realDomain = real.slice(real.lastIndexOf("@") + 1);
  const claimedDomain = m[1].toLowerCase();
  if (!realDomain || claimedDomain === realDomain) return null;
  return m[0];
}

type RawHeader = { key: string; value: string };

/** Assemble the stored header block from a postal-mime parse. */
export function storedHeadersFrom(parsed: {
  messageId?: string | null;
  inReplyTo?: string | null;
  references?: string | string[] | null;
  from?: ParsedMailbox | null;
  replyTo?: ParsedMailbox[] | null;
  to?: ParsedMailbox[] | null;
  cc?: ParsedMailbox[] | null;
  headers?: RawHeader[];
}): StoredHeaders {
  const first = (key: string) => (parsed.headers || []).find((h) => h.key.toLowerCase() === key)?.value;
  const out: StoredHeaders = {
    messageId: parsed.messageId || "",
    inReplyTo: parsed.inReplyTo || "",
  };
  const references = referenceChain(parsed.references);
  if (references.length) out.references = references;
  // Reply-To only matters when it points somewhere other than From.
  const fromAddr = (parsed.from?.address || "").toLowerCase();
  const replyTo = mailboxes(parsed.replyTo).slice(0, 10);
  if (replyTo.length && !(replyTo.length === 1 && replyTo[0].address.toLowerCase() === fromAddr)) {
    out.replyTo = replyTo;
  }
  const to = mailboxes(parsed.to);
  if (to.length) out.to = to;
  const cc = mailboxes(parsed.cc);
  if (cc.length) out.cc = cc;
  const unsubscribe = parseListUnsubscribe(first("list-unsubscribe"), first("list-unsubscribe-post"));
  if (unsubscribe) out.unsubscribe = unsubscribe;
  // Only the boundary MX's verdicts, parsed structurally (authResults.ts): a
  // sender can write any Authentication-Results they like lower down, and can
  // even plant "dmarc=pass" in the envelope address the real one echoes.
  const authHeader = first("authentication-results");
  if (authHeader) {
    const v = trustedAuthVerdicts(authHeader);
    out.auth = { spf: v.spf, dkim: v.dkim, dmarc: v.dmarc };
  }
  return out;
}
