// Recipient suggestions derived from mail you have already exchanged.
//
// No new storage: the `messages` table already holds every address you have
// corresponded with. People you have WRITTEN to are the strongest signal, so
// outbound recipients rank above inbound senders, and recency breaks ties.

export interface Contact {
  /** Address, lowercased. */
  email: string;
  /** Display name if one was ever seen, else "". */
  name: string;
}

export interface ContactsEnv {
  DB: D1Database;
}

/** Max suggestions returned. A dropdown longer than this is noise. */
export const MAX_CONTACTS = 8;
/** Rows scanned per direction. This makes suggestions "recently contacted",
 *  not "most contacted": on a busy mailbox 400 messages may be only days. */
const SCAN_LIMIT = 400;
/** Cap on a single stored address-list value before parsing. */
const MAX_ADDRESS_LIST_CHARS = 4000;
/** Deliberately STRICTER than the compose field's validator, which accepts
 *  "a@x.com>" because its domain class only excludes whitespace and "@". A
 *  suggestion we offer should always be sendable, so require a real dotted
 *  domain and exclude the punctuation that only shows up in malformed headers. */
const ADDRESS_RE =
  /^[^\s@<>,;"()]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/**
 * Split an address list ("A <a@x>, b@y") into its raw entries, trimmed, with
 * empty ones dropped. A comma or semicolon inside a quoted display name or an
 * angle-addr is not a separator: `"Doe, John" <j@x>` is ONE entry. Single pass.
 */
export function splitAddressList(value: string): string[] {
  const out: string[] = [];
  const push = (entry: string) => {
    const t = entry.trim();
    if (t) out.push(t);
  };
  // `quoted` gates the depth counter: a "<" inside a quoted name is text, not a
  // bracket, and letting it move depth swallowed every address after it.
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let current = "";
  for (const ch of value) {
    if (escaped) {
      escaped = false;
      current += ch;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      current += ch;
      continue;
    }
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === "<") depth++;
    else if (!quoted && ch === ">") depth = Math.max(0, depth - 1);
    // Semicolons separate addresses too, and terminate RFC 5322 group syntax.
    if ((ch === "," || ch === ";") && !quoted && depth === 0) {
      push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  push(current);
  return out;
}

/**
 * Parse a stored address list ("A <a@x>, b@y") into individual contacts.
 * Stored values come from headers, so they are comma-joined and may carry
 * display names, quotes and angle brackets.
 */
export function parseAddressList(raw: unknown): Contact[] {
  // Bound the input. Header values are attacker-controlled (msg_from is built
  // from parsed.from.name), and a 40 KB run of "<" is a real inbound message.
  const value = String(raw ?? "").slice(0, MAX_ADDRESS_LIST_CHARS);
  if (!value) return [];
  return splitAddressList(value).flatMap(parseOne);
}

// Control characters and whitespace runs in a display name. Written with
// escapes so no literal control character sits in this file.
const NAME_NOISE = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\s]+", "g");
// RFC 5322 "specials" that force a display name into a quoted-string. The dot
// is special too, but obs-phrase permits it bare and every parser accepts it,
// so "Amazon.com" is not wrapped in quotes for nothing.
const NAME_NEEDS_QUOTING = /[()<>[\]:;@\\,"]/;

/** A display name as one line of text: controls and whitespace runs → one space. */
export function cleanDisplayName(name: string | null | undefined): string {
  return (name ?? "").replace(NAME_NOISE, " ").trim();
}

/**
 * Render a mailbox for storage and display: `Name <addr>`, with the name as an
 * RFC 5322 quoted-string (backslash and quote escaped) when it contains a
 * character that would otherwise change how the string parses. Unquoted,
 * `Doe, John <j@x>` reads as two entries and the sender becomes "John"; a name
 * holding "<...>" reads as a second address. No name → `<addr>`.
 */
export function formatMailbox(name: string | null | undefined, address: string): string {
  const clean = cleanDisplayName(name);
  if (!clean) return `<${address}>`;
  const shown = NAME_NEEDS_QUOTING.test(clean) ? `"${clean.replace(/[\\"]/g, "\\$&")}"` : clean;
  return `${shown} <${address}>`;
}

/**
 * Strip the RFC 5322 decoration from one entry: comments ("a@x.com (Alice)")
 * and a leading group label ("Team: ..."). Both are recognised only OUTSIDE a
 * quoted string. A display name like "Sales: Support" or "Acme (Billing)" is
 * rendered quoted by formatMailbox, and treating its colon or parentheses as
 * syntax cut the name to `Support"` or dropped part of it.
 * Also reports where the last unquoted "<" is, i.e. where the angle-addr starts.
 */
function undecorate(entry: string): { text: string; angle: number } {
  let text = "";
  let quoted = false;
  let colon = -1;
  let noMoreClosers = false;
  for (let i = 0; i < entry.length; i++) {
    const ch = entry[i];
    if (quoted) {
      text += ch;
      // A backslash escapes the next character only inside a quoted string.
      if (ch === "\\" && i + 1 < entry.length) text += entry[++i];
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === "(" && !noMoreClosers) {
      const close = entry.indexOf(")", i + 1);
      if (close !== -1) {
        text += " ";
        i = close;
        continue;
      }
      noMoreClosers = true; // unbalanced: an ordinary character, and stop looking
    } else if (ch === ":" && colon === -1) colon = text.length;
    text += ch;
  }
  if (colon !== -1 && !text.slice(0, colon).includes("@")) text = text.slice(colon + 1);
  text = text.trim();

  let angle = -1;
  quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === "\\") i++;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === "<") angle = i;
  }
  // An unterminated quote swallowed the address: fall back to the plain last "<".
  if (angle === -1 || quoted) angle = text.lastIndexOf("<");
  return { text, angle };
}

function parseOne(entry: string): Contact[] {
  const { text: s, angle: lt } = undecorate(entry.trim());
  if (!s) return [];

  // Index scan rather than /^(.*)<([^>]+)>$/: that regex backtracks quadratically
  // when it FAILS on a string with many "<", which one inbound message can
  // trigger. Measured 4x per doubling; 40k "<" cost ~570 ms per call.
  let email: string;
  let name = "";
  const gt = lt >= 0 ? s.indexOf(">", lt + 1) : -1;
  if (lt >= 0 && gt > lt) {
    email = s.slice(lt + 1, gt).trim();
    name = s.slice(0, lt).trim();
  } else {
    email = s;
  }
  email = email.toLowerCase();
  // Use the same shape the compose field validates with. A looser check let
  // "a@x.com>" through, and it survived the client validator too, so the user
  // could send to a broken address from a suggestion that looked fine.
  if (!ADDRESS_RE.test(email)) return [];
  // Only a quoted-string is unescaped: bare, a backslash is just a character.
  if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) {
    name = name.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return [{ email, name: name.trim() }];
}

/** True when `c` matches what the user has typed so far. */
export function contactMatches(c: Contact, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return c.email.includes(q) || c.name.toLowerCase().includes(q);
}

/**
 * Suggest recipients for `query`, most useful first.
 *
 * Ranking: addresses you have sent to outrank ones that have only written to
 * you (you chose the former; anyone can be the latter, including spam), and
 * more recent contact wins within each group.
 */
export async function suggestContacts(
  env: ContactsEnv,
  query: string,
  limit = MAX_CONTACTS,
): Promise<Contact[]> {
  const [sent, received] = await Promise.all([
    env.DB.prepare(
      // folder is set once at insert ('sent' for outbound, 'inbox' for inbound)
      // and never mutated - archiving and trashing move `state`, not `folder`.
      // Naming it lets this use idx_messages_folder_date(folder, date DESC);
      // filtering on `direction` alone forces a full scan plus a temp B-tree
      // sort. `direction` stays for correctness if those ever diverge.
      `SELECT msg_to AS addrs FROM messages
        WHERE folder='sent' AND direction='out' AND msg_to IS NOT NULL AND msg_to <> ''
        ORDER BY date DESC LIMIT ?`,
    )
      .bind(SCAN_LIMIT)
      .all<{ addrs: string }>(),
    env.DB.prepare(
      `SELECT msg_from AS addrs FROM messages
        WHERE folder='inbox' AND direction='in' AND msg_from IS NOT NULL AND msg_from <> ''
        ORDER BY date DESC LIMIT ?`,
    )
      .bind(SCAN_LIMIT)
      .all<{ addrs: string }>(),
  ]);

  // Build the identity map FIRST, then filter. Filtering during collection
  // matched on name, and a sent row for an address you typed bare carries no
  // display name - so a name query skipped it in the sent group and picked it
  // up in the received group, ranking a stranger above someone you email daily.
  const seen = new Map<string, Contact & { sent: boolean }>();
  const add = (rows: { addrs: string }[] | undefined, sent: boolean) => {
    for (const row of rows ?? []) {
      for (const c of parseAddressList(row.addrs)) {
        const existing = seen.get(c.email);
        if (!existing) seen.set(c.email, { ...c, sent });
        else {
          // Rows arrive newest-first, so first sighting wins on order; a later
          // row may still carry the display name an earlier one lacked, and
          // being in the sent group at all outranks received-only.
          if (!existing.name && c.name) existing.name = c.name;
          if (sent) existing.sent = true;
        }
      }
    }
  };
  add(sent.results, true);
  add(received.results, false);

  const all = Array.from(seen.values());
  const matches = all.filter((c) => contactMatches(c, query));
  // Stable partition: sent-group first, each group still newest-first.
  return [...matches.filter((c) => c.sent), ...matches.filter((c) => !c.sent)]
    .slice(0, limit)
    .map(({ email, name }) => ({ email, name }));
}
