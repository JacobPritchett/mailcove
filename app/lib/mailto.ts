// ---------------------------------------------------------------------------
// Defensive parser for mailto: URLs (RFC 6068).
//
// The input is attacker-controlled: it comes from a link inside received mail,
// or from a URL the OS hands to the app as a protocol handler. The result
// prefills the compose dialog, so the parser is an allowlist. Only recipients,
// subject, and body come through, every field is bounded and stripped of
// control characters, and nothing here can throw.
//
// Pure and dependency-free so it is unit-tested apart from the compose UI
// (mirrors lib/recipients.ts).
// ---------------------------------------------------------------------------

export interface MailtoFields {
  /** Comma-joined addresses ("a@x.com, b@y.com"), "" when none. */
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
}

/** Longer input is cut here before any parsing, so the work is bounded. */
const MAX_INPUT = 8000;
const MAX_ADDRESSES = 50;
/** The longest address SMTP can carry (RFC 5321 path limit). */
const MAX_ADDRESS_LENGTH = 254;
const MAX_SUBJECT = 500;
const MAX_BODY = 20000;

const SCHEME = /^mailto:/i;

/**
 * Conservative single-address shape: ASCII atom characters, exactly one @, and
 * a dotted domain. Not RFC-complete on purpose (no quoted local parts, no
 * internationalised addresses). A link that needs those is rare, and a
 * prefilled recipient the user did not type should be unambiguous to read.
 */
const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

/**
 * C0 controls, DEL, C1 controls, and the bidi embedding, override, and isolate
 * characters. The bidi set can reorder how a prefilled field displays, so the
 * text the user approves would not be the text that is sent.
 */
const CONTROLS = /[\u0000-\u001F\u007F-\u009F‪-‮⁦-⁩]/g;
/** The same set, minus the tab and newline a message body legitimately uses. */
const BODY_CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F‪-‮⁦-⁩]/g;
/** With the u flag a surrogate pair is one code point, so this matches only unpaired halves. */
const LONE_SURROGATES = /[\uD800-\uDFFF]/gu;
const PERCENT_RUN = /(?:%[0-9A-Fa-f]{2})+/g;

/**
 * Percent-decode without ever throwing (decodeURIComponent throws on any bad
 * sequence, which would let one stray % discard the whole link).
 *
 * Text that is not a valid escape ("%", "%zz") stays as literal text. Bytes
 * that are not valid UTF-8 are dropped. "+" is left alone: it only means a
 * space in form encoding, and in a mailto: URL it is a real character that
 * shows up in addresses like "ann+tag@x.com".
 */
function percentDecode(value: string): string {
  return value.replace(PERCENT_RUN, (run) => {
    const bytes = new Uint8Array(run.length / 3);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(run.slice(i * 3 + 1, i * 3 + 3), 16);
    }
    // Non-fatal decoding marks each invalid byte with U+FFFD. Removing the
    // marker gives "decode what is valid, drop the rest".
    return new TextDecoder().decode(bytes).replace(/�/g, "");
  });
}

/** Cut to `max` UTF-16 units, then remove unpaired surrogates (including one the cut just made). */
function clamp(value: string, max: number): string {
  return value.slice(0, max).replace(LONE_SURROGATES, "");
}

function cleanSubject(value: string): string {
  // A newline in a subject is a header injection attempt, so each run of them
  // becomes one space before the remaining controls are removed.
  return clamp(value.replace(/[\r\n]+/g, " ").replace(CONTROLS, ""), MAX_SUBJECT);
}

function cleanBody(value: string): string {
  return clamp(value.replace(/\r\n?/g, "\n").replace(BODY_CONTROLS, ""), MAX_BODY);
}

/**
 * Add every valid address in a decoded, comma-separated list to `out`.
 * `seen` holds lowercased addresses already in the field, for de-duplication.
 */
function collectAddresses(decoded: string, out: string[], seen: Set<string>): void {
  for (const piece of decoded.split(",")) {
    if (out.length >= MAX_ADDRESSES) return;
    let candidate = piece.replace(CONTROLS, "").trim();
    // "Name <addr>": keep only what is inside the final angle brackets. The
    // display name is dropped because it is attacker-chosen text that could
    // name someone other than the real recipient.
    if (candidate.endsWith(">")) {
      const open = candidate.lastIndexOf("<");
      if (open === -1) continue;
      candidate = candidate.slice(open + 1, -1).trim();
    }
    if (candidate.length > MAX_ADDRESS_LENGTH || !ADDRESS.test(candidate)) continue;
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
}

/** null when `raw` is not a mailto: URL at all. */
export function parseMailto(raw: string): MailtoFields | null {
  if (typeof raw !== "string") return null;
  const input = raw.slice(0, MAX_INPUT).trim();
  if (!SCHEME.test(input)) return null;
  const rest = input.slice("mailto:".length);

  // Split on the first literal "?" before decoding, so an encoded "?" (%3F)
  // in the path cannot start a set of hfields.
  const q = rest.indexOf("?");
  const path = q === -1 ? rest : rest.slice(0, q);
  const query = q === -1 ? "" : rest.slice(q + 1);

  const to: string[] = [];
  const cc: string[] = [];
  const bcc: string[] = [];
  const seenTo = new Set<string>();
  const seenCc = new Set<string>();
  const seenBcc = new Set<string>();
  let subject: string | null = null;
  let body: string | null = null;

  collectAddresses(percentDecode(path), to, seenTo);

  for (const pair of query.split("&")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const name = percentDecode(pair.slice(0, eq)).toLowerCase();
    const value = pair.slice(eq + 1);
    // An explicit allowlist. Everything else is ignored, notably "attach" and
    // "attachment" (some clients attach the named local file, which lets a
    // link exfiltrate data) and "from", "reply-to", and "in-reply-to" (which
    // would let a link set identity or threading headers).
    switch (name) {
      case "to":
        collectAddresses(percentDecode(value), to, seenTo);
        break;
      case "cc":
        collectAddresses(percentDecode(value), cc, seenCc);
        break;
      case "bcc":
        collectAddresses(percentDecode(value), bcc, seenBcc);
        break;
      case "subject":
        // First one wins, so a later hfield cannot replace what an earlier
        // one already set.
        if (subject === null) subject = cleanSubject(percentDecode(value));
        break;
      case "body":
        if (body === null) body = cleanBody(percentDecode(value));
        break;
    }
  }

  return {
    to: to.join(", "),
    cc: cc.join(", "),
    bcc: bcc.join(", "),
    subject: subject ?? "",
    body: body ?? "",
  };
}

/**
 * The mailto: URL carried by the app's own handler URL
 * (`/?compose=<percent-encoded mailto:...>`), or null. Takes a location.search string.
 *
 * Parsed by hand rather than with URLSearchParams, which reads "+" as a space
 * and would corrupt "ann+tag@x.com" in a handler URL that was not fully encoded.
 */
export function mailtoFromSearch(search: string): string | null {
  if (typeof search !== "string") return null;
  const query = search.startsWith("?") ? search.slice(1) : search;
  for (const pair of query.split("&")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    if (percentDecode(pair.slice(0, eq)) !== "compose") continue;
    // Only the first compose parameter counts, so a second one appended to the
    // URL cannot override it.
    const value = percentDecode(pair.slice(eq + 1)).trim();
    return SCHEME.test(value) ? value : null;
  }
  return null;
}
