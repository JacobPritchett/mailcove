// Attachments that survive a saved draft.
//
// Staged files live in the browser as base64 and were lost the moment compose
// closed. They are stored apart from the draft row for one reason: the body
// autosaves every 1.5s while the user types, and the attachment set changes
// only when they add or remove a file. Putting 10MB of base64 on the autosave
// path would re-upload the whole set on every keystroke.
//
// So the bytes go to R2 as ONE object per draft, and D1 keeps only a small
// manifest (name/type/size) so the drafts list can say "2 attachments" without
// touching R2.
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  MAX_TOTAL_ATTACHMENT_BYTES,
  AttachmentError,
  sanitizeAttachmentFilename,
  sanitizeMimeType,
  decodeBase64,
} from "./attachments";

/** What the drafts list needs: enough to describe a file, none of its bytes. */
export interface DraftAttachmentMeta {
  name: string;
  type: string;
  size: number;
}

/** A stored attachment, base64 exactly as the browser staged it. */
export interface DraftAttachment extends DraftAttachmentMeta {
  data: string;
}

/** R2 key for a draft's attachment blob. */
export function draftAttachmentKey(draftId: string): string {
  return `draftatt/${draftId}.json`;
}

/**
 * Validate a staged attachment set.
 *
 * Deliberately keeps the ORIGINAL base64 rather than decoding and re-encoding:
 * decoding is still done, because it is the only way to know the true byte
 * length and to reject a malformed payload, but the round-trip through
 * btoa/String.fromCharCode on a 5MB file is both wasteful and a stack hazard.
 */
export function parseDraftAttachments(raw: unknown): DraftAttachment[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new AttachmentError("attachments must be an array");
  if (raw.length > MAX_ATTACHMENTS) {
    throw new AttachmentError(`too many attachments (max ${MAX_ATTACHMENTS})`);
  }

  let total = 0;
  const out: DraftAttachment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      throw new AttachmentError("each attachment must be an object");
    }
    const rec = item as Record<string, unknown>;
    const data = rec.data;
    if (typeof data !== "string") throw new AttachmentError("attachment data must be a string");

    // Throws on anything that is not decodable base64, and on oversize.
    const bytes = decodeBase64(data);
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentError("attachment is too large");
    }
    total += bytes.length;
    if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new AttachmentError("attachments are too large in total");
    }

    out.push({
      name: sanitizeAttachmentFilename(rec.name),
      type: sanitizeMimeType(rec.type),
      size: bytes.length,
      data,
    });
  }
  return out;
}

/** Strip the bytes — what goes in the D1 column. */
export function manifestOf(items: readonly DraftAttachment[]): DraftAttachmentMeta[] {
  return items.map(({ name, type, size }) => ({ name, type, size }));
}

/**
 * Read a stored manifest. Never throws: a draft whose manifest is unreadable
 * should still open, minus its attachment list, rather than 500.
 */
export function parseManifest(raw: string | null | undefined): DraftAttachmentMeta[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v
      .filter((x): x is DraftAttachmentMeta => !!x && typeof x === "object")
      .map((x) => ({
        name: String(x.name ?? ""),
        type: String(x.type ?? ""),
        size: Number(x.size ?? 0),
      }));
  } catch {
    return [];
  }
}

export async function putDraftAttachments(
  env: { MAILSTORE: R2Bucket },
  draftId: string,
  items: readonly DraftAttachment[],
): Promise<void> {
  if (items.length === 0) {
    await deleteDraftAttachments(env, draftId);
    return;
  }
  await env.MAILSTORE.put(draftAttachmentKey(draftId), JSON.stringify(items), {
    httpMetadata: { contentType: "application/json" },
  });
}

/** The full set, bytes included. Missing or corrupt object → no attachments. */
export async function getDraftAttachments(
  env: { MAILSTORE: R2Bucket },
  draftId: string,
): Promise<DraftAttachment[]> {
  const obj = await env.MAILSTORE.get(draftAttachmentKey(draftId));
  if (!obj) return [];
  try {
    const v = JSON.parse(await obj.text());
    return Array.isArray(v) ? (v as DraftAttachment[]) : [];
  } catch {
    return [];
  }
}

export async function deleteDraftAttachments(
  env: { MAILSTORE: R2Bucket },
  draftId: string,
): Promise<void> {
  await env.MAILSTORE.delete(draftAttachmentKey(draftId));
}

/** Ignore anything written recently: a blob younger than this may belong to a
 *  draft whose row is still being written. */
const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;
/**
 * D1 binds at most 100 parameters per statement — verified against the live
 * database, where 100 succeeds and 101 fails with "too many SQL variables".
 */
const ID_CHUNK = 100;

/**
 * Delete attachment blobs whose draft no longer exists.
 *
 * Writes are ordered row-then-bytes, so a blob without a row is either a draft
 * deleted while R2 was unavailable (that cleanup is best-effort, deliberately)
 * or a row removed outside the API. Neither is reachable by the user, so the
 * bytes would otherwise sit in R2 forever.
 *
 * Deliberately conservative: only blobs older than the grace period are even
 * considered, so a draft mid-save is never swept, and a lookup failure keeps
 * the blob. Leaving an orphan one more day costs a few KB; deleting a live
 * attachment loses the user's file.
 */
export async function purgeOrphanedDraftAttachments(
  env: { DB: D1Database; MAILSTORE: R2Bucket },
  now: number,
): Promise<{ purged: number }> {
  const listed = await env.MAILSTORE.list({ prefix: "draftatt/", limit: 1000 });
  const candidates = listed.objects
    .filter((o) => now - o.uploaded.getTime() > ORPHAN_GRACE_MS)
    .map((o) => ({ key: o.key, id: o.key.slice("draftatt/".length).replace(/\.json$/, "") }))
    .filter((c) => c.id.length > 0);
  if (candidates.length === 0) return { purged: 0 };

  const live = new Set<string>();
  for (let i = 0; i < candidates.length; i += ID_CHUNK) {
    const chunk = candidates.slice(i, i + ID_CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const { results } = await env.DB.prepare(
      `SELECT id FROM drafts WHERE id IN (${placeholders})`,
    )
      .bind(...chunk.map((c) => c.id))
      .all<{ id: string }>();
    for (const r of results ?? []) live.add(r.id);
  }

  let purged = 0;
  for (const c of candidates) {
    if (live.has(c.id)) continue;
    await env.MAILSTORE.delete(c.key);
    purged++;
  }
  return { purged };
}
