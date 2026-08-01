// Attachment handling.
//
// Outbound: the client posts files as base64 inside the JSON body (no multipart
// parsing in the Worker). Everything there is caller-controlled, and the filename
// ends up in a Content-Disposition header, so each field is validated.
//
// Inbound: storage sits on the DELIVERY path, where the message row is inserted
// afterwards, so that work is bounded and best-effort by design.


/** Caps are ours, not the platform's. Cloudflare Email Sending enforces its own
 *  message-size limit, which may reject a message these caps allow. */
export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export interface OutboundAttachment {
  filename: string;
  type: string;
  content: Uint8Array;
}

export class AttachmentError extends Error {}

/**
 * Make a caller-supplied filename safe to put in a header and to show in a UI.
 * Strips CR/LF and other controls (header injection), quotes and backslashes
 * (they terminate or escape the quoted-string in Content-Disposition), and any
 * path separators so a name can never read as a path. Never returns "".
 */
export function sanitizeAttachmentFilename(raw: unknown): string {
  const cleaned = String(raw ?? "")
    // C0, DEL and C1 controls, plus invisible/bidi formatting characters. Those
    // last ones are the point: a right-to-left override renders
    // "invoice<RLO>fdp.exe" as something a reader sees as "invoiceexe.pdf",
    // which is a real filename-spoofing trick rather than a theoretical one.
    .replace(
      /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]+/gu,
      " ",
    )
    // Separators become "-" so a name can never read as a path. Backslash is
    // flattened HERE, before quotes are dropped, so both separators behave the
    // same way (previously the quote pass deleted backslashes first).
    .replace(/[/\\]+/g, "-")
    // A quote would terminate the quoted-string in Content-Disposition.
    .replace(/"/g, "")
    .replace(/^\.+/, "")
    .replace(/\s+/g, " ")
    .trim();
  return truncateFilename(cleaned) || "attachment";
}

/** Trim to a sane length without splitting a surrogate pair or dropping the
 *  extension, which is the part a reader actually scans for. */
export function truncateFilename(name: string, max = 200): string {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : "";
  const stem = ext ? name.slice(0, dot) : name;
  // Array.from splits by code point, so the slice cannot end mid surrogate pair.
  return Array.from(stem).slice(0, max - ext.length).join("") + ext;
}

/** Restrict the declared type to a single well-formed MIME token. Anything odd
 *  becomes the generic binary type rather than being echoed into a header. */
export function sanitizeMimeType(raw: unknown): string {
  const value = String(raw ?? "").trim().toLowerCase();
  // type/subtype with the RFC 2045 token charset, no parameters.
  return /^[a-z0-9!#$&^_.+-]{1,64}\/[a-z0-9!#$&^_.+-]{1,64}$/.test(value)
    ? value
    : "application/octet-stream";
}

/** Largest base64 string worth decoding: 4 chars per 3 bytes, plus data: prefix
 *  slack. Checked BEFORE atob so an oversized payload is refused rather than
 *  materialized. */
export const MAX_ENCODED_CHARS = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 128;

/** Decode strict base64 (optionally a data: URL) to bytes. Throws on garbage. */
export function decodeBase64(raw: unknown): Uint8Array {
  let value = String(raw ?? "").trim();
  // Reject on the ENCODED length first. Decoding then measuring would let a
  // caller materialize the body string, the atob result and the byte array
  // (~3x the payload) before the size cap is ever consulted, which is enough to
  // take out a 128 MB isolate with a single request.
  if (value.length > MAX_ENCODED_CHARS) {
    throw new AttachmentError(
      `attachment is too large (max ${Math.floor(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB each)`,
    );
  }
  // Browsers hand back "data:<type>;base64,<payload>" from FileReader.
  const comma = value.startsWith("data:") ? value.indexOf(",") : -1;
  if (comma !== -1) value = value.slice(comma + 1);
  value = value.replace(/\s+/g, "");
  if (!value) throw new AttachmentError("empty attachment");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new AttachmentError("attachment is not valid base64");
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new AttachmentError("attachment is not valid base64");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Validate and decode the `attachments` field of a send request.
 * Returns [] when absent. Throws AttachmentError with a user-facing message.
 */
export function parseOutboundAttachments(raw: unknown): OutboundAttachment[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new AttachmentError("attachments must be an array");
  if (raw.length > MAX_ATTACHMENTS) {
    throw new AttachmentError(`too many attachments (max ${MAX_ATTACHMENTS})`);
  }

  // Sum the ENCODED sizes first: this is O(1) per item and refuses an oversized
  // batch before a single byte is decoded.
  const encodedTotal = raw.reduce(
    (n: number, item: unknown) =>
      n + (typeof item === "object" && item !== null ? String((item as { data?: unknown }).data ?? "").length : 0),
    0,
  );
  if (encodedTotal > Math.ceil(MAX_TOTAL_ATTACHMENT_BYTES / 3) * 4 + 128) {
    throw new AttachmentError(
      `attachments are too large (max ${Math.floor(MAX_TOTAL_ATTACHMENT_BYTES / 1024 / 1024)} MB total)`,
    );
  }

  const out: OutboundAttachment[] = [];
  let total = 0;
  for (const item of raw) {
    if (typeof item !== "object" || item === null) {
      throw new AttachmentError("each attachment must be an object");
    }
    const { filename, type, data } = item as Record<string, unknown>;
    const content = decodeBase64(data);
    if (content.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentError(
        `attachment is too large (max ${Math.floor(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB each)`,
      );
    }
    total += content.byteLength;
    if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new AttachmentError(
        `attachments are too large (max ${Math.floor(MAX_TOTAL_ATTACHMENT_BYTES / 1024 / 1024)} MB total)`,
      );
    }
    out.push({
      filename: sanitizeAttachmentFilename(filename),
      type: sanitizeMimeType(type),
      content,
    });
  }
  return withUniqueFilenames(out);
}

/**
 * Make every filename distinct ("report.pdf", "report (2).pdf").
 *
 * The download route finds an attachment by NAME and then reads its partId, so
 * two files sharing a name would both resolve to the first one's bytes. Picking
 * same-named files from different folders is easy, and sanitizing can collide
 * names that started out different.
 */
export function withUniqueFilenames(items: OutboundAttachment[]): OutboundAttachment[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const key = item.filename.toLowerCase();
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    if (count === 0) return item;
    const dot = item.filename.lastIndexOf(".");
    const stem = dot > 0 ? item.filename.slice(0, dot) : item.filename;
    const ext = dot > 0 ? item.filename.slice(dot) : "";
    return { ...item, filename: `${stem} (${count + 1})${ext}` };
  });
}

// ------------------------------------------------------------- inbound

/** Ceiling on stored inbound parts. Real mail is nowhere near this; the cap
 *  exists so a pathological message cannot turn one delivery into thousands of
 *  sequential object writes. */
export const MAX_INBOUND_ATTACHMENTS = 50;
/** Metadata is cheap, so keep more records than we store bytes for. */
export const MAX_INBOUND_RECORDS = 200;
/** How many puts are in flight at once. Bounded so a many-part message finishes
 *  quickly without opening an unbounded number of connections. */
const INBOUND_PUT_CONCURRENCY = 6;

export interface InboundPart {
  filename?: string | null;
  mimeType?: string | null;
  contentId?: string | null;
  disposition?: string | null;
  content?: unknown;
}

export interface StoredInbound<R> {
  records: R[];
  /** Parts whose bytes were NOT written (over the cap, or the write failed). */
  skipped: number;
}

/**
 * Write inbound attachment bytes, bounded and best-effort.
 *
 * Delivery is what matters: the caller inserts the message row AFTER this, so
 * anything that throws here would leave mail stored in R2 but invisible in the
 * inbox. Failures are therefore counted, not raised — a message that arrives
 * without one attachment beats a message that never arrives.
 */
export async function storeInboundAttachments<R extends { partId: string; mimeType: string }>(
  put: (key: string, body: unknown, opts: { httpMetadata: { contentType: string } }) => Promise<unknown>,
  id: string,
  parts: InboundPart[],
  toRecord: (part: InboundPart, index: number) => R,
): Promise<StoredInbound<R & { stored: boolean }>> {
  const capped = parts.slice(0, MAX_INBOUND_ATTACHMENTS);
  // Record EVERY part, including ones past the cap. Dropping them outright made
  // a 200-attachment message render as a tidy 50-attachment one, with no name,
  // count or marker to say anything was missing. A record marked stored:false
  // at least tells the truth, and raw/<id>.eml still holds every byte.
  const records = parts
    .slice(0, MAX_INBOUND_RECORDS)
    .map((p, i) => ({ ...toRecord(p, i), stored: i < capped.length }));
  let skipped = Math.max(0, parts.length - capped.length);

  // Iterate the STORED subset, not every record: records now includes over-cap
  // parts (marked stored:false) that have no bytes to write.
  for (let i = 0; i < capped.length; i += INBOUND_PUT_CONCURRENCY) {
    const slice = records.slice(i, Math.min(i + INBOUND_PUT_CONCURRENCY, capped.length));
    // The callback is async on purpose. allSettled only converts rejections of
    // the promises it receives; if `put` throws while being CALLED, that
    // exception unwinds map() before allSettled ever runs, escaping the
    // "counted, not raised" contract and aborting ingest. An async callback
    // turns a sync throw into a rejection the counter below already handles.
    const results = await Promise.allSettled(
      slice.map(async (rec, n) =>
        put(`att/${id}/${rec.partId}`, capped[i + n].content, {
          httpMetadata: { contentType: rec.mimeType || "application/octet-stream" },
        }),
      ),
    );
    results.forEach((r, n) => {
      if (r.status === "rejected") {
        skipped += 1;
        // Mark it so the UI can tell "we have this file" from "we know a file
        // was here". Without this the record looks complete and 404s on click.
        slice[n].stored = false;
      }
    });
  }
  return { records, skipped };
}
