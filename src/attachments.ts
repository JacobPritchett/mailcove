// Inbound attachment handling.
//
// This sits on the DELIVERY path: handleEmail stores the raw message, parses it,
// writes attachment bytes, and only then inserts the message row. Anything that
// throws in between leaves mail in R2 that never appears in the inbox, so the
// work here is bounded and best-effort by design.

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
