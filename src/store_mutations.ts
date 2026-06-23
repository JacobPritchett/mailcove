// Mailbox state mutations. Every action fans out across all messages sharing a
// thread_id (conversation-level semantics). Pure D1/R2 — callers authenticate
// first. `now` is injected so tests are deterministic.

import { ftsDelete } from "./search";

export const MAIL_ACTIONS = [
  "archive", "unarchive", "trash", "restore", "delete",
  "star", "unstar", "read", "unread",
] as const;
export type MailAction = (typeof MAIL_ACTIONS)[number];
const ACTION_SET = new Set<string>(MAIL_ACTIONS);
export function isMailAction(x: unknown): x is MailAction {
  return typeof x === "string" && ACTION_SET.has(x);
}

interface MutEnv { DB: D1Database; MAILSTORE: R2Bucket; }

async function threadRows(env: MutEnv, threadId: string) {
  const { results } = await env.DB
    .prepare(`SELECT id, state, r2_raw_key FROM messages WHERE thread_id=?`)
    .bind(threadId)
    .all<{ id: string; state: string; r2_raw_key: string | null }>();
  return results ?? [];
}

/** Delete every R2 object belonging to a message: parsed body, raw eml, and all attachments. */
async function deleteMessageR2(env: MutEnv, id: string, rawKey: string | null): Promise<void> {
  for (const k of [`parsed/${id}.json`, ...(rawKey ? [rawKey] : [])]) {
    try { await env.MAILSTORE.delete(k); } catch { /* object may not exist */ }
  }
  // Attachments: enumerate by prefix (filenames are arbitrary), paginate defensively.
  let cursor: string | undefined;
  do {
    const listed = await env.MAILSTORE.list({ prefix: `att/${id}/`, cursor });
    for (const o of listed.objects) {
      try { await env.MAILSTORE.delete(o.key); } catch { /* object may not exist */ }
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

export async function mutateThread(env: MutEnv, threadId: string, action: MailAction, now: number): Promise<void> {
  const D = env.DB;
  switch (action) {
    case "archive":
      await D.prepare(`UPDATE messages SET state='archived' WHERE thread_id=? AND state!='trash'`).bind(threadId).run();
      return;
    case "unarchive":
      await D.prepare(`UPDATE messages SET state='inbox' WHERE thread_id=? AND state='archived'`).bind(threadId).run();
      return;
    case "trash":
      // Remember each message's pre-trash state so Undo/restore returns it to
      // wherever it was (inbox OR archived), not unconditionally to inbox. Only
      // capture when not already trashed, so a double-trash can't clobber it.
      await D.prepare(
        `UPDATE messages SET pre_trash_state = CASE WHEN state!='trash' THEN state ELSE pre_trash_state END, state='trash', trashed_at=? WHERE thread_id=?`,
      ).bind(now, threadId).run();
      return;
    case "restore":
      // Restore to the captured pre-trash state (fallback 'inbox' for rows that
      // predate the column), then clear the capture + trash timestamp.
      await D.prepare(
        `UPDATE messages SET state=COALESCE(pre_trash_state,'inbox'), pre_trash_state=NULL, trashed_at=NULL WHERE thread_id=? AND state='trash'`,
      ).bind(threadId).run();
      return;
    case "delete": {
      const rows = await threadRows(env, threadId);
      if (rows.length === 0) return;
      if (rows.some((r) => r.state !== "trash")) throw new Error("delete requires the thread to be in trash");
      for (const r of rows) await deleteMessageR2(env, r.id, r.r2_raw_key);
      await D.prepare(`DELETE FROM messages WHERE thread_id=?`).bind(threadId).run();
      await ftsDelete(env, rows.map((r) => r.id)); // best-effort; keep the index in sync
      return;
    }
    case "star":   await D.prepare(`UPDATE messages SET starred=1 WHERE thread_id=?`).bind(threadId).run(); return;
    case "unstar": await D.prepare(`UPDATE messages SET starred=0 WHERE thread_id=?`).bind(threadId).run(); return;
    case "read":   await D.prepare(`UPDATE messages SET unread=0 WHERE thread_id=?`).bind(threadId).run(); return;
    case "unread": await D.prepare(`UPDATE messages SET unread=1 WHERE thread_id=?`).bind(threadId).run(); return;
  }
}

export async function mutateThreads(env: MutEnv, threadIds: string[], action: MailAction, now: number): Promise<{ count: number }> {
  const ids = threadIds.slice(0, 200);
  for (const id of ids) await mutateThread(env, id, action, now);
  return { count: ids.length };
}

const THIRTY_DAYS_MS = 30 * 24 * 3600 * 1000;

export async function purgeOldTrash(env: MutEnv, now: number): Promise<{ purged: number }> {
  const cutoff = now - THIRTY_DAYS_MS;
  // Delete the D1 rows FIRST (atomically, capturing them via RETURNING), THEN
  // remove their R2 objects. This closes the purge/restore race: a `restore`
  // that lands before this DELETE clears `trashed_at`, so the row no longer
  // matches the cutoff and is spared (its R2 body is untouched); a restore after
  // the DELETE has nothing to act on. Either way we only delete R2 for rows we
  // actually removed from D1.
  const { results } = await env.DB
    .prepare(`DELETE FROM messages WHERE state='trash' AND trashed_at < ? RETURNING id, r2_raw_key`)
    .bind(cutoff)
    .all<{ id: string; r2_raw_key: string | null }>();
  const rows = results ?? [];
  for (const r of rows) await deleteMessageR2(env, r.id, r.r2_raw_key);
  await ftsDelete(env, rows.map((r) => r.id)); // best-effort; keep the index in sync
  return { purged: rows.length };
}
