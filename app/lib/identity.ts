// The local part of a From address, as the Worker will actually use it.

/**
 * Mirror of the Worker's sanitizer (src/domains.ts sanitizeLocal): anything
 * but letters, digits, dot, underscore and hyphen is dropped. Kept identical
 * so the From a composer shows is the From the message goes out with.
 */
export function sanitizeLocal(value: string): string {
  return value.replace(/[^a-z0-9._-]/gi, "");
}

/**
 * The mailbox behind a delivered-to local part: "me+shop" is the mailbox "me".
 * A plus tag is how a sender-side filter addresses mail TO us; we do not send
 * from one.
 */
export function baseLocal(local: string): string {
  const plus = local.indexOf("+");
  return sanitizeLocal(plus === -1 ? local : local.slice(0, plus));
}
