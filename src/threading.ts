// Derive a stable conversation key (thread_id) from a parsed email's reference
// headers. The thread root is the FIRST id in the References chain (RFC 5322
// References lists ancestors oldest-first), so every reply in a chain collapses
// to the same key. Falls back to In-Reply-To, then Message-ID, then a caller-
// supplied id (our internal uuid) when no headers are usable.

/** Longest thread id we will derive from a header. Real Message-IDs run to a
 *  couple of hundred characters at most; anything past this is not one. */
export const MAX_THREAD_ID_CHARS = 400;

/** Characters a thread id must not contain: C0/C1 controls, space and DEL.
 *  Slashes are deliberately allowed: real Message-IDs contain them, threads are
 *  already stored under such ids, and the client percent-encodes the id so it
 *  travels as one path segment. Built from escapes so no literal control
 *  character ever sits in this file. */
const UNSAFE_THREAD_ID_CHARS = new RegExp("[\\u0000-\\u0020\\u007f-\\u009f]");

/**
 * Strip surrounding angle brackets / whitespace from a single message-id token.
 * Index scans, not /^<+/ and />+$/: the second backtracks quadratically on a
 * long run of ">" that is not at the end, and this value is a raw header.
 */
function stripId(raw: string): string {
  const t = raw.trim();
  let start = 0;
  let end = t.length;
  while (start < end && t.charCodeAt(start) === 60 /* < */) start++;
  while (end > start && t.charCodeAt(end - 1) === 62 /* > */) end--;
  return t.slice(start, end).trim();
}

/**
 * Turn one header token into a thread id, or null if it cannot serve as one.
 *
 * The id is derived verbatim from sender-controlled headers and then used as a
 * URL path segment, so it has to survive that trip: "." and ".." are removed by
 * URL normalization (the thread becomes unopenable), and a lone surrogate
 * makes encodeURIComponent throw in the client.
 */
function threadIdFrom(raw: string): string | null {
  // Bound the work before touching the string (slack covers brackets/padding).
  if (raw.length > MAX_THREAD_ID_CHARS + 64) return null;
  const id = stripId(raw);
  if (!id || id.length > MAX_THREAD_ID_CHARS) return null;
  if (UNSAFE_THREAD_ID_CHARS.test(id)) return null;
  if (/^\.+$/.test(id)) return null;
  try {
    encodeURIComponent(id);
  } catch {
    return null; // ill-formed UTF-16
  }
  return id;
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
 * Precedence: References root → In-Reply-To → Message-ID → fallbackId, skipping
 * any candidate that is not usable as an id (see threadIdFrom). For References
 * that means the first USABLE token, so one hostile entry at the front falls
 * through to the next ancestor rather than to a brand-new thread.
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
      const id = threadIdFrom(tok);
      if (id) return id; // first usable id = thread root
    }
  }

  if (parsed.inReplyTo) {
    const id = threadIdFrom(parsed.inReplyTo);
    if (id) return id;
  }

  if (parsed.messageId) {
    const id = threadIdFrom(parsed.messageId);
    if (id) return id;
  }

  return fallbackId;
}
