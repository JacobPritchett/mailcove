// Outbound recipients, normalized to one address per entry before anything is
// counted, sent or stored. Callers hand To/Cc/Bcc in several shapes (a string
// list, an array of strings, structured {name, email}); every one of them used
// to be a way to pack many addresses into what the cap counted as one.

import { cleanDisplayName, formatMailbox, parseAddressList, splitAddressList } from "./contacts";

/** A recipient as the send binding accepts it: a bare address or {name, email}. */
export type Recipient = string | { name?: string; email: string };

/** A request that names a recipient we will not send to (as opposed to junk we skip). */
export class RecipientError extends Error {}

// One mailbox, dotted domain, nothing that could break a header.
const SINGLE_ADDRESS = /^[^\s@<>,;"()\u0000-\u001f\u007f]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * Normalize one recipient field. Entries with no "@" at all are skipped (a
 * stray null or number is junk, not a recipient). Anything that names an
 * address but is malformed, carries control characters, or hides a second
 * address is an error: sending to fewer people than the caller listed, without
 * saying so, is worse than refusing.
 */
export function parseRecipients(value: unknown): Recipient[] {
  const out: Recipient[] = [];
  const items = Array.isArray(value) ? value : value ? [value] : [];
  for (const item of items) {
    if (typeof item === "string") {
      for (const piece of splitAddressList(item)) {
        const entry = piece.trim();
        if (!entry.includes("@")) continue;
        if (CONTROL.test(entry)) throw new RecipientError("invalid recipient");
        // Exactly one mailbox per entry, or the cap below counts wrong.
        const parsed = parseAddressList(entry);
        if (parsed.length !== 1) throw new RecipientError(`invalid recipient: ${entry.slice(0, 80)}`);
        // Send what was validated, not the text it was validated from: the
        // parser bounds and tolerates, so the raw entry can hold more than the
        // one mailbox it reported.
        const { name, email } = parsed[0];
        out.push(name ? formatMailbox(name, email) : email);
      }
    } else if (item && typeof item === "object" && typeof (item as { email?: unknown }).email === "string") {
      const email = (item as { email: string }).email.trim();
      if (!email.includes("@")) continue;
      if (!SINGLE_ADDRESS.test(email)) throw new RecipientError(`invalid recipient: ${email.slice(0, 80)}`);
      const rawName = (item as { name?: unknown }).name;
      const name = typeof rawName === "string" ? cleanDisplayName(rawName) : "";
      out.push(name ? { name, email } : { email });
    }
  }
  return out;
}

/** Render a recipient for storage/display ("Name <addr>"), never "[object Object]". */
export function recipientText(r: Recipient): string {
  if (typeof r === "string") return r;
  return r.name ? formatMailbox(r.name, r.email) : r.email;
}
