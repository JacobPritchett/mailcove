// ---------------------------------------------------------------------------
// Recipient parsing for the compose "To" field.
//
// Pure, dependency-free helpers so the chip-input logic is unit-tested in
// isolation from the React component (mirrors lib/chatNormalize.ts). The server
// re-splits a comma-joined `to` itself, so this is purely a UX layer: turn what
// the user types into validated address chips.
// ---------------------------------------------------------------------------

/** Delimiters that separate one address from the next while typing/pasting. */
const DELIMITERS = /[\s,;]+/;

/**
 * Conservative email check. Not RFC-complete (no quoted local parts), but it
 * rejects the mistakes that actually bounce: missing @, spaces, no dot in the
 * domain, empty halves. Trimmed + case-insensitive.
 */
export function isValidEmail(value: string): boolean {
  const s = value.trim();
  // local@domain.tld — single @, no whitespace, a dotted multi-label domain.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

/** Split a raw string into non-empty tokens on commas/semicolons/whitespace. */
export function splitRecipientTokens(raw: string): string[] {
  return raw.split(DELIMITERS).filter((t) => t.length > 0);
}

export interface CommitResult {
  /** The updated recipient list (existing + newly committed, deduped). */
  recipients: string[];
  /** Tokens that failed validation, in input order. */
  invalid: string[];
  /** Leftover text to keep in the input (only when keepTrailing is set). */
  remainder: string;
}

export interface CommitOptions {
  /**
   * When true, a final token NOT followed by a delimiter is treated as an
   * in-progress fragment: it is returned as `remainder` instead of being
   * committed/validated. Use this for live onChange parsing so the user can
   * keep typing. Leave false (default) when committing on Enter/blur, where the
   * whole input should resolve to chips.
   */
  keepTrailing?: boolean;
}

/**
 * Fold raw input into the recipient list. Valid tokens are normalized
 * (trim + lowercase) and appended, deduped case-insensitively against both the
 * existing list and each other. Invalid tokens are collected separately so the
 * caller can surface them. Returns a new array; never mutates `existing`.
 */
export function commitRecipients(
  existing: string[],
  raw: string,
  opts: CommitOptions = {},
): CommitResult {
  let remainder = "";
  let work = raw;
  if (opts.keepTrailing && !DELIMITERS.test(raw.slice(-1))) {
    // Peel off the trailing, not-yet-delimited fragment.
    const tokens = splitRecipientTokens(raw);
    remainder = tokens.length ? tokens[tokens.length - 1] : "";
    // Re-derive the committed portion by dropping that last fragment.
    const cut = raw.lastIndexOf(remainder);
    work = cut >= 0 ? raw.slice(0, cut) : "";
  }

  const recipients = [...existing];
  const seen = new Set(existing.map((e) => e.toLowerCase()));
  const invalid: string[] = [];

  for (const token of splitRecipientTokens(work)) {
    if (!isValidEmail(token)) {
      invalid.push(token);
      continue;
    }
    const norm = token.trim().toLowerCase();
    if (seen.has(norm)) continue;
    seen.add(norm);
    recipients.push(norm);
  }

  return { recipients, invalid, remainder };
}
