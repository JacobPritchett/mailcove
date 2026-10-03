// Bound what the MIME parser is asked to chew on.
//
// postal-mime parses an address header in time quadratic in the number of
// comma-separated entries: about a second at 100 KB, several at 200 KB. That is
// sender-controlled CPU on the delivery path, and a Workers CPU kill is not an
// exception anyone can catch: the mail is simply lost. A real To or Cc header
// is a few hundred bytes; one over the cap below is either an attack or a list
// so long that showing its first hundred-odd recipients loses nothing.
//
// Only the copy handed to the parser is trimmed. The raw message is stored and
// forwarded untouched.

/** Longest address header value the parser is given, in bytes. */
export const MAX_ADDRESS_HEADER_BYTES = 8 * 1024;
/** How far into the message the header block is searched for. */
const MAX_HEADER_SCAN_BYTES = 512 * 1024;

const ADDRESS_HEADERS = new Set([
  "from", "to", "cc", "bcc", "reply-to", "sender",
  "resent-from", "resent-to", "resent-cc", "resent-bcc", "resent-sender",
  "return-receipt-to", "disposition-notification-to",
]);

const LF = 0x0a, CR = 0x0d, SP = 0x20, TAB = 0x09, COLON = 0x3a, COMMA = 0x2c;

/** Lowercased ASCII header name of the field starting at `start`, or "". */
function fieldName(bytes: Uint8Array, start: number, end: number): string {
  let name = "";
  for (let i = start; i < end && i - start < 40; i++) {
    const b = bytes[i];
    if (b === COLON) return name;
    if (b <= SP || b >= 0x7f) return "";
    name += String.fromCharCode(b >= 0x41 && b <= 0x5a ? b + 32 : b);
  }
  return "";
}

/**
 * Return `raw` with any over-long address header cut back to
 * MAX_ADDRESS_HEADER_BYTES (at a comma, so the last address kept is whole).
 * The same buffer is returned when nothing needed trimming. Linear in the
 * header block; the body is never scanned.
 */
export function boundAddressHeaders(raw: ArrayBuffer): ArrayBuffer {
  const bytes = new Uint8Array(raw);
  const scanEnd = Math.min(bytes.length, MAX_HEADER_SCAN_BYTES);
  const out: Uint8Array[] = [];
  let copiedTo = 0;
  let trimmed = false;
  let i = 0;
  while (i < scanEnd) {
    // One field: a line plus its folded continuation lines.
    const fieldStart = i;
    let lineEnd = bytes.indexOf(LF, i);
    if (lineEnd === -1 || lineEnd >= scanEnd) break;
    // A blank line ends the header block.
    if (lineEnd === fieldStart || (lineEnd === fieldStart + 1 && bytes[fieldStart] === CR)) break;
    let fieldEnd = lineEnd + 1;
    while (fieldEnd < scanEnd && (bytes[fieldEnd] === SP || bytes[fieldEnd] === TAB)) {
      lineEnd = bytes.indexOf(LF, fieldEnd);
      if (lineEnd === -1 || lineEnd >= scanEnd) {
        lineEnd = scanEnd - 1;
        fieldEnd = scanEnd;
        break;
      }
      fieldEnd = lineEnd + 1;
    }
    if (fieldEnd - fieldStart > MAX_ADDRESS_HEADER_BYTES && ADDRESS_HEADERS.has(fieldName(bytes, fieldStart, fieldEnd))) {
      let cut = fieldStart + MAX_ADDRESS_HEADER_BYTES;
      const lastComma = bytes.lastIndexOf(COMMA, cut);
      // Keep at least the header name and something after it.
      if (lastComma > fieldStart + 64) cut = lastComma;
      out.push(bytes.subarray(copiedTo, cut), new Uint8Array([CR, LF]));
      copiedTo = fieldEnd;
      trimmed = true;
    }
    i = fieldEnd;
  }
  if (!trimmed) return raw;
  out.push(bytes.subarray(copiedTo));
  const total = out.reduce((n, c) => n + c.length, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const c of out) {
    joined.set(c, at);
    at += c.length;
  }
  return joined.buffer;
}

/**
 * Pull one header's value out of the raw message without a MIME parser, for
 * the case where the parser itself failed. ASCII only, unfolded, bounded;
 * "" when absent. Good enough to label an unreadable message, nothing more.
 */
export function rawHeader(raw: ArrayBuffer, name: string): string {
  const bytes = new Uint8Array(raw, 0, Math.min(raw.byteLength, 64 * 1024));
  let text = "";
  for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i] < 0x80 ? bytes[i] : 0x3f);
  const end = text.search(/\r?\n\r?\n/);
  const head = (end === -1 ? text : text.slice(0, end)).replace(/\r?\n[ \t]+/g, " ");
  const want = name.toLowerCase() + ":";
  for (const line of head.split(/\r?\n/)) {
    if (line.slice(0, want.length).toLowerCase() === want) return line.slice(want.length).trim().slice(0, 500);
  }
  return "";
}
