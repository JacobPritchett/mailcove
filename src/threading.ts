// Derive a stable conversation key (thread_id) from a parsed email's reference
// headers. The thread root is the FIRST id in the References chain (RFC 5322
// References lists ancestors oldest-first), so every reply in a chain collapses
// to the same key. Falls back to In-Reply-To, then Message-ID, then a caller-
// supplied id (our internal uuid) when no headers are usable.

/** Strip surrounding angle brackets / whitespace from a single message-id token. */
function stripId(raw: string): string {
  return raw.trim().replace(/^<+/, "").replace(/>+$/, "").trim();
}

// Matches any C0 control char, space, or DEL. Used to reject header-injection /
// malformed Message-ID values. Kept as a RegExp constant so the control-char
// class doesn't trip up source tooling.
const UNSAFE_MSGID_CHARS = new RegExp("[\\u0000-\\u0020\\u007f]");

/**
 * Sanitize a candidate RFC 5322 Message-ID before it is used as an *outbound*
 * header value (In-Reply-To / References). This is a security boundary: the
 * value originates from untrusted inbound mail / API callers, so we must never
 * let it inject additional headers (CRLF) or emit a malformed header that would
 * fail delivery.
 *
 * Rules:
 *  - trim surrounding whitespace
 *  - REJECT (null) if empty, or if it contains any CR/LF/control char, space, or
 *    other internal whitespace
 *  - if it lacks angle brackets, wrap the bare token in `<...>`
 *  - only accept a single well-formed `<...>` token (no spaces inside)
 *
 * @returns the canonical `<id@host>` form, or null if the value is unusable.
 */
export function sanitizeMessageId(v: string | undefined | null): string | null {
  if (v == null) return null;
  const t = v.trim();
  if (!t) return null;
  // After trim, any remaining control char / whitespace / DEL is disqualifying.
  if (UNSAFE_MSGID_CHARS.test(t)) return null;
  // Already a single, well-formed angle-bracketed token: <...> with no inner
  // angle brackets.
  if (/^<[^<>]+>$/.test(t)) return t;
  // Bare token (no angle brackets at all) — wrap it.
  if (!t.includes("<") && !t.includes(">")) return `<${t}>`;
  return null;
}

export interface ThreadHeaders {
  /** RFC 5322 References — a space-separated string or an array of ids. */
  references?: string | string[];
  inReplyTo?: string;
  messageId?: string;
}

/**
 * Compute the thread_id for an inbound message.
 * Precedence: References root → In-Reply-To → Message-ID → fallbackId.
 */
export function deriveThreadId(parsed: ThreadHeaders, fallbackId: string): string {
  const refs = parsed.references;
  if (refs) {
    // Normalize to a flat list of tokens. A References header is space-separated;
    // when it arrives as an array, each element may itself still contain multiple
    // whitespace-joined ids (e.g. ["<root> <mid>"]), so split each element too.
    const tokens = Array.isArray(refs)
      ? refs.flatMap((r) => r.trim().split(/\s+/))
      : refs.trim().split(/\s+/);
    for (const tok of tokens) {
      const id = stripId(tok);
      if (id) return id; // first non-empty id = thread root
    }
  }

  if (parsed.inReplyTo) {
    const id = stripId(parsed.inReplyTo);
    if (id) return id;
  }

  if (parsed.messageId) {
    const id = stripId(parsed.messageId);
    if (id) return id;
  }

  return fallbackId;
}
