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
