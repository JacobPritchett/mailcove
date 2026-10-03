// Pure view transforms for the message UI. `now` is injected wherever the
// current time matters so callers (and tests) stay deterministic — no Date.now().

/**
 * Format a message timestamp for a list row.
 * Same calendar day as `now` → a local time like "9:41 AM".
 * Otherwise → short month + day like "Jun 3".
 */
export function formatDate(ms: number, now: number): string {
  const d = new Date(ms);
  const ref = new Date(now);
  const sameDay =
    d.getFullYear() === ref.getFullYear() &&
    d.getMonth() === ref.getMonth() &&
    d.getDate() === ref.getDate();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * Display label for a sender field.
 * "Name <addr@x>" → "Name"; bare "addr@x" → "addr@x"; "" → "".
 */
export function senderLabel(msgFrom: string): string {
  const s = msgFrom.trim();
  if (!s) return "";
  // Index scan rather than /^(.*?)<[^>]*>\s*$/, which backtracks quadratically
  // when the input holds many "<" and no closing ">" — every "<" re-runs
  // [^>]* to the end. Measured 147ms at 20k chars and 9s at 160k, and this now
  // runs over To/Cc entries as well as From, all of them straight off the wire.
  if (s.endsWith(">")) {
    const open = s.lastIndexOf("<");
    if (open >= 0) {
      const name = unquoteName(s.slice(0, open).trim());
      if (name) return name;
      // "<addr@x>" with no name → fall through to the bare address.
      return addressOf(s);
    }
  }
  return s;
}

/**
 * Strip the quotes RFC 5322 puts around a display name that carries a comma.
 *
 * Only a well-formed quoted-string is unwrapped, and a backslash is an escape
 * only inside one: unescaping unconditionally turns the perfectly ordinary
 * name `Domain\User` into `DomainUser`.
 */
function unquoteName(name: string): string {
  if (name.length < 2 || name[0] !== '"') return name;
  let out = "";
  for (let i = 1; i < name.length; i++) {
    const c = name[i];
    if (c === "\\" && i + 1 < name.length) {
      out += name[++i];
      continue;
    }
    // A closing quote anywhere but the end means this was never one
    // quoted-string (`"a" and "b"`), so leave the text exactly as it came.
    if (c === '"') return i === name.length - 1 ? out.trim() : name;
    out += c;
  }
  return name; // unterminated quote — not ours to reinterpret
}

/**
 * Extract the email address from "Name <addr>" or return the bare string.
 */
export function addressOf(msgFrom: string): string {
  const s = msgFrom.trim();
  if (!s) return "";
  const m = s.match(/<([^>]*)>\s*$/);
  return m ? m[1].trim() : s;
}

/** Longest address header we will parse; see splitAddressList. */
const MAX_HEADER_CHARS = 2000;

/**
 * Split an address header into its entries.
 *
 * A plain `split(",")` is wrong here: a display name may be quoted and contain
 * a comma ("Doe, John" <j@x> is ONE recipient), so commas inside quotes or
 * angle brackets are not separators. Scans once and never backtracks — this
 * runs over attacker-supplied header text on every render.
 */
export function splitAddressList(raw: string): string[] {
  // A header is never legitimately this long, and the result only ever feeds a
  // one-line summary. Bounding the input bounds every downstream cost.
  const text = raw.length > MAX_HEADER_CHARS ? raw.slice(0, MAX_HEADER_CHARS) : raw;
  const out: string[] = [];
  let start = 0;
  let quoted = false;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    // A backslash escapes only INSIDE a quoted-string; outside one it is an
    // ordinary character (and `a\, b@y` is two recipients, not one).
    if (quoted && c === "\\") { i++; continue; }
    if (c === '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    // Bounded to 0/1: nested "<" is malformed, and letting depth run up means a
    // single stray bracket eats every comma after it.
    if (c === "<") depth = 1;
    else if (c === ">") depth = 0;
    else if ((c === "," || c === ";") && depth === 0) {
      const part = text.slice(start, i).trim();
      if (part) out.push(part);
      start = i + 1;
    }
  }
  const tail = text.slice(start).trim();
  if (tail) out.push(tail);

  // An unclosed "<" or quote means the scan above stopped separating, so the
  // whole rest of the header collapsed into one entry — and "to alice@x.com" on
  // a message that went to forty people is a false statement about the message.
  // Fail toward over-counting: re-split naively on the delimiters.
  if ((depth !== 0 || quoted) && out.length <= 1) {
    return text.split(/[,;]/).map((t) => t.trim()).filter(Boolean);
  }
  return out;
}

/**
 * Short "to …" summary for a message header, in the reader.
 * One recipient reads as their name; more collapse to "name and N others" so
 * the header stays one line however many people were copied.
 */
export function recipientSummary(rawTo: string, rawCc?: string | null): string {
  const all = [...splitAddressList(rawTo ?? ""), ...splitAddressList(rawCc ?? "")];
  if (all.length === 0) return "";
  const first = senderLabel(all[0]);
  if (all.length === 1) return first;
  const rest = all.length - 1;
  return `${first} and ${rest} other${rest === 1 ? "" : "s"}`;
}

/**
 * Initials for an avatar. Names give two letters, a bare address gives one.
 * Uses the code POINT, not charCodeAt, so a name starting with an emoji or an
 * astral-plane character yields that character rather than half a surrogate.
 */
export function initialsOf(label: string): string {
  // Index by code POINT: `w[0]` on an emoji-prefixed name is half a surrogate
  // pair, which renders as a replacement glyph.
  const firstOf = (w: string) => [...w][0] ?? "";
  // Marketing senders open with a decoration ("\u{1F389} Acme"); the initial a
  // reader recognises is the first alphanumeric word, so skip past those.
  const words = label.trim().split(/\s+/).filter((w) => /\p{L}|\p{N}/u.test(firstOf(w)));
  if (words.length === 0) {
    const c = firstOf(label.trim());
    return c ? c.toUpperCase() : "?";
  }
  const take = (w: string) => firstOf(w).toUpperCase();
  return words.length === 1 ? take(words[0]) : take(words[0]) + take(words[1]);
}

/**
 * A stable hue for a sender's avatar, so the same correspondent is the same
 * colour on every message. Any hash would do; this one just has to be pure.
 */
export function avatarHue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return h;
}

/**
 * Background for an avatar carrying WHITE initials.
 *
 * The lightness is not a taste choice: hue rotates with the sender, and white
 * on hsl(60 45% 32%) - a yellow - is only 2.94:1, under the 4.5:1 WCAG AA
 * floor for text. 32% keeps the worst hue at 4.77:1, so every sender is
 * legible rather than just most of them. Pinned by a test over all 360 hues.
 */
export function avatarColor(seed: string): string {
  return `hsl(${avatarHue(seed)} 45% 32%)`;
}

/**
 * Reader timestamp: an absolute date the user can cite, plus the relative
 * distance they actually think in — "Jul 21 (13 days ago)".
 */
export function formatFullDate(ms: number, now: number): string {
  const d = new Date(ms);
  const dayMs = 86_400_000;
  // Compare calendar days in LOCAL time. Dividing the raw epoch difference
  // would call a 23:59 message "1 day ago" one minute later.
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(new Date(now)) - startOf(d)) / dayMs);

  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (days === 0) return time;
  const date = d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" }),
  });
  if (days === 1) return `${date} (yesterday)`;
  if (days > 1 && days < 30) return `${date} (${days} days ago)`;
  return date;
}

/** A server message as a sentence: "that is one of your own domains" reads as a fragment. */
export function asSentence(message: string): string {
  const s = message.trim();
  if (!s) return "";
  return s[0].toUpperCase() + s.slice(1) + (/[.!?]$/.test(s) ? "" : ".");
}

/**
 * A subject as the name of a conversation: the reply and forward prefixes that
 * pile up as it goes back and forth ("Re: RE: Fwd: Lunch") are dropped. Only
 * leading ones, and only whole prefixes ("Regarding lunch" is left alone).
 */
export function conversationSubject(subject: string | null | undefined): string {
  const s = (subject ?? "").trim();
  // Anchored, and no two adjacent parts can match the same text, so a subject
  // made of thousands of spaces is still read once.
  return s.replace(/^(?:(?:re|fwd?)\s*(?:\[\d{1,3}\]\s*)?:\s*)+/i, "").trim();
}
