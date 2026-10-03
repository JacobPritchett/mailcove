// Client-side attachment staging for compose.
//
// Caps mirror src/attachments.ts. The server is the real gate — these exist so a
// user learns a file is too big immediately, instead of after uploading it and
// waiting for a 400.

export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export interface StagedAttachment {
  name: string;
  type: string;
  size: number;
  /** Base64 payload, no data: prefix. */
  data: string;
}

/**
 * Which of a forwarded message's files fit the send limits, in their original
 * order, and why each of the others does not. "Too large" and "too many" are
 * different problems with different remedies, so they are kept apart.
 */
export function planForward<T extends { name: string; size: number }>(
  parts: readonly T[],
): { fits: T[]; tooLarge: string[]; tooMany: string[] } {
  const fits: T[] = [];
  const tooLarge: string[] = [];
  const tooMany: string[] = [];
  let total = 0;
  for (const part of parts) {
    if (part.size > MAX_ATTACHMENT_BYTES || total + part.size > MAX_TOTAL_ATTACHMENT_BYTES) tooLarge.push(part.name);
    else if (fits.length >= MAX_ATTACHMENTS) tooMany.push(part.name);
    else {
      fits.push(part);
      total += part.size;
    }
  }
  return { fits, tooLarge, tooMany };
}

/** Human-readable size, e.g. "1.2 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Read a File into base64 without the data: prefix. */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.onload = () => {
      const result = String(reader.result || "");
      const comma = result.indexOf(",");
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Decide whether `incoming` can join `existing`. Returns an error message when
 * it cannot, so the caller can surface one specific reason rather than failing
 * the whole selection silently.
 */
export function checkAttachmentLimits(
  existing: readonly StagedAttachment[],
  incoming: readonly File[],
): string | null {
  if (existing.length + incoming.length > MAX_ATTACHMENTS) {
    return `You can attach up to ${MAX_ATTACHMENTS} files.`;
  }
  const oversized = incoming.find((f) => f.size > MAX_ATTACHMENT_BYTES);
  if (oversized) {
    return `${oversized.name} is larger than ${formatBytes(MAX_ATTACHMENT_BYTES)}.`;
  }
  const total =
    existing.reduce((n, a) => n + a.size, 0) + incoming.reduce((n, f) => n + f.size, 0);
  if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
    return `Attachments total more than ${formatBytes(MAX_TOTAL_ATTACHMENT_BYTES)}.`;
  }
  return null;
}
