// Parser for ONE Authentication-Results header value (RFC 8601).
//
// The header is written by our boundary MX, but it is not free of sender
// input: the envelope sender is echoed in the SPF comment and in
// `smtp.mailfrom=`, and "=" is legal in a local part. MAIL FROM
// `dmarc=pass@evil.com` therefore puts the literal text "dmarc=pass" into a
// header whose real verdict is dmarc=fail, and searching the value for that
// text reads the forgery. A verdict is taken only from where the grammar puts
// it: the start of a `;`-separated result, outside comments and quoted strings.

export type AuthVerdict = "pass" | "fail" | "none";
export interface AuthVerdicts {
  /** The host that wrote the header: first token of the value, lowercased,
   *  version dropped. "" when absent. Verdicts are only as trustworthy as this. */
  authservId: string;
  spf: AuthVerdict;
  dkim: AuthVerdict;
  dmarc: AuthVerdict;
}

/**
 * The authserv-id our boundary MX (Cloudflare Email Routing) stamps. A message
 * also carries whatever Authentication-Results headers earlier hops, or the
 * sender, put in it (forwarded mail arrives with mx.google.com's and others'
 * lower down). Only a header written by this host is evidence of anything; if
 * the boundary header is missing, the topmost one is somebody else's claim.
 */
export const TRUSTED_AUTHSERV_ID = "mx.cloudflare.net";

/** Characters of the header examined. A real one is a few hundred. */
const MAX_AUTH_RESULTS_CHARS = 16_384;

/** Results that mean the check was made and the message did not pass it. */
const FAILING = new Set(["fail", "softfail", "permerror", "policy"]);

// `method = result` at the very start of a result segment, with the result
// ending at whitespace or the end of the segment. That last part matters: a
// ";" smuggled in through an unquoted address would start a new segment
// reading "dmarc=pass@evil.com", and "pass" followed by "@" is not a result.
const RESINFO = /^\s*(spf|dkim|dmarc)\s*=\s*([a-z]+)(?=\s|$)/i;

/**
 * Remove comments (nested, with backslash escapes) and quoted strings, in one
 * pass. Each becomes a single space. Anything after an unterminated comment or
 * quote is dropped: it is inside it.
 */
function stripCommentsAndQuotes(value: string): string {
  let out = "";
  let depth = 0;
  let quoted = false;
  let start = 0; // start of the pending run of ordinary text
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (depth > 0 || quoted) {
      if (c === 92 /* \ */) i++;
      else if (quoted) {
        if (c === 34 /* " */) { quoted = false; start = i + 1; }
      } else if (c === 40 /* ( */) depth++;
      else if (c === 41 /* ) */ && --depth === 0) start = i + 1;
      continue;
    }
    if (c === 40 || c === 34) {
      out += value.slice(start, i) + " ";
      if (c === 40) depth = 1;
      else quoted = true;
    }
  }
  return depth > 0 || quoted ? out : out + value.slice(start);
}

/**
 * The authserv-id and the SPF, DKIM and DMARC verdicts stated by one
 * Authentication-Results value.
 *
 * - The first `;` segment is the authserv-id (plus an optional version) and
 *   never a result.
 * - spf / dkim: a header routinely carries several results (SPF for HELO and
 *   for MAIL FROM, one DKIM result per signature). Any pass is a pass;
 *   otherwise any failing result is a fail; otherwise "none".
 * - dmarc: there is one policy evaluation, so "pass" only when EVERY dmarc
 *   result is a pass. A second, injected result can never upgrade the real one.
 * - softfail, permerror and policy count as fail; everything else (none,
 *   neutral, temperror, unknown words) is "none".
 *
 * This reports what the header SAYS. Whether to believe it is the caller's
 * decision: see trustedAuthVerdicts.
 */
export function authVerdicts(value: string | null | undefined): AuthVerdicts {
  const seen = {
    spf: { pass: 0, fail: 0, other: 0 },
    dkim: { pass: 0, fail: 0, other: 0 },
    dmarc: { pass: 0, fail: 0, other: 0 },
  };
  let authservId = "";
  if (value) {
    const segments = stripCommentsAndQuotes(value.slice(0, MAX_AUTH_RESULTS_CHARS)).split(";");
    authservId = (segments[0].trim().split(/\s+/)[0] || "").toLowerCase();
    for (let i = 1; i < segments.length; i++) {
      const m = RESINFO.exec(segments[i]);
      if (!m) continue;
      const method = m[1].toLowerCase() as "spf" | "dkim" | "dmarc";
      const result = m[2].toLowerCase();
      seen[method][result === "pass" ? "pass" : FAILING.has(result) ? "fail" : "other"]++;
    }
  }
  type Tally = { pass: number; fail: number; other: number };
  const anyPass = (s: Tally): AuthVerdict => (s.pass ? "pass" : s.fail ? "fail" : "none");
  const allPass = (s: Tally): AuthVerdict => (s.fail ? "fail" : s.pass && !s.other ? "pass" : "none");
  return { authservId, spf: anyPass(seen.spf), dkim: anyPass(seen.dkim), dmarc: allPass(seen.dmarc) };
}

/**
 * Verdicts to base a trust decision on: those of `value` if it was written by
 * our boundary MX, and all "none" otherwise.
 */
export function trustedAuthVerdicts(value: string | null | undefined): AuthVerdicts {
  const v = authVerdicts(value);
  return v.authservId === TRUSTED_AUTHSERV_ID ? v : { authservId: v.authservId, spf: "none", dkim: "none", dmarc: "none" };
}
