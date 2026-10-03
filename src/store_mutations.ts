// Mailbox state mutations. A user action fans out across all messages sharing a
// thread_id (conversation-level semantics); an inbox filter touches only the
// message it matched (mutateMessage). Pure D1/R2 — callers authenticate first.
// `now` is injected so tests are deterministic.


export const MAIL_ACTIONS = [
  "archive", "unarchive", "trash", "restore", "delete",
  "star", "unstar", "read", "unread", "spam", "unspam", "snooze", "unsnooze",
] as const;
export type MailAction = (typeof MAIL_ACTIONS)[number];
const ACTION_SET = new Set<string>(MAIL_ACTIONS);
export function isMailAction(x: unknown): x is MailAction {
  return typeof x === "string" && ACTION_SET.has(x);
}

interface MutEnv { DB: D1Database; MAILSTORE: R2Bucket; }

/** Furthest ahead a thread may be snoozed. */
const MAX_SNOOZE_MS = 366 * 24 * 3600 * 1000;

/** A snooze time must be a whole number of ms, in the future, within a year. */
export function isSnoozeTime(until: unknown, now: number): until is number {
  return typeof until === "number" && Number.isInteger(until) && until > now && until <= now + MAX_SNOOZE_MS;
}

export interface WokenThread { thread_id: string; subject: string | null; msg_from: string | null }

/**
 * End every snooze whose time has passed. The inbox view already shows such a
 * thread (its predicate compares against the clock), so this is not what makes
 * it reappear; it records WHEN it woke (so it keeps its place at the top after
 * the snooze column is cleared), marks the latest inbound message unread, and
 * returns the woken threads so the caller can notify. Idempotent.
 */
export async function wakeSnoozed(env: { DB: D1Database }, now: number): Promise<WokenThread[]> {
  const { results } = await env.DB.prepare(
    `UPDATE messages
        SET woke_at = snoozed_until,
            snoozed_until = NULL,
            unread = CASE
              WHEN direction='in' AND state='inbox' AND date = (SELECT MAX(x.date) FROM messages x WHERE x.thread_id = messages.thread_id AND x.direction='in' AND x.state='inbox')
              THEN 1 ELSE unread END
      WHERE snoozed_until IS NOT NULL AND snoozed_until <= ?
  RETURNING thread_id, subject, msg_from, direction, state`,
  )
    .bind(now)
    .all<WokenThread & { direction: string; state: string }>();
  // Only threads the inbox actually lists are worth announcing: a snoozed
  // thread holding nothing but my own sent mail wakes quietly.
  const seen = new Set<string>();
  return (results ?? [])
    .filter((r) => r.direction === "in" && r.state === "inbox")
    .filter((r) => (seen.has(r.thread_id) ? false : (seen.add(r.thread_id), true)));
}

async function threadRows(env: MutEnv, threadId: string) {
  const { results } = await env.DB
    .prepare(`SELECT id, state, r2_raw_key FROM messages WHERE thread_id=?`)
    .bind(threadId)
    .all<{ id: string; state: string; r2_raw_key: string | null }>();
  return results ?? [];
}

/** R2 accepts at most this many keys in one delete call. */
const R2_DELETE_BATCH = 1000;
/** D1 rejects a statement with more than 100 bound parameters. */
const ID_CHUNK = 100;

const errText = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

/**
 * Delete every R2 object belonging to a message: parsed body, raw eml, and all
 * attachments. Throws if any of it fails (deleting a key that does not exist is
 * not an error in R2, so a rejection is a real failure).
 */
async function deleteMessageR2(env: MutEnv, id: string, rawKey: string | null): Promise<void> {
  const keys = [`parsed/${id}.json`, ...(rawKey ? [rawKey] : [])];
  // Attachments: enumerate by prefix (filenames are arbitrary), paginate defensively.
  let cursor: string | undefined;
  do {
    const listed = await env.MAILSTORE.list({ prefix: `att/${id}/`, cursor });
    for (const o of listed.objects) keys.push(o.key);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  // One call per batch rather than one per object: this runs for up to a
  // hundred messages in a single invocation, and subrequests are capped.
  for (let i = 0; i < keys.length; i += R2_DELETE_BATCH) {
    await env.MAILSTORE.delete(keys.slice(i, i + R2_DELETE_BATCH));
  }
}

interface Tombstone { id: string; r2_raw_key: string | null }

/** Tombstones cleaned up per call. Each costs an R2 list and an R2 delete, and
 *  a Worker that exceeds its limits is killed, not thrown at. */
export const DRAIN_BATCH = 100;

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(",");

/**
 * Finish deleting mail whose row is already gone: for each tombstone, remove
 * the search-index entry and every stored object (parsed body, raw message,
 * attachments), and only then the tombstone itself.
 *
 * The tombstone is the ONLY record that this content still exists, so it is
 * dropped only when all of its cleanup succeeded. Everything here is
 * idempotent, so a run that is killed part-way is simply repeated.
 *
 * With `rows`, cleans up those tombstones (what a purge or delete-forever just
 * claimed); without, the oldest DRAIN_BATCH in the table. A tombstone whose
 * cleanup fails does not stop the batch, and is moved to the back of the queue
 * (its `created` is bumped) so one that fails every time cannot keep newer
 * ones from ever being reached.
 *
 * Content is never deleted for an id that has a `messages` row. Ids are uuids,
 * so a tombstone and a live row cannot share one; this makes that a checked
 * invariant instead of an assumption, and such a tombstone is discarded.
 */
export async function drainPendingDeletes(
  env: MutEnv,
  now: number,
  rows?: Tombstone[],
): Promise<{ drained: number; failed: number }> {
  const batch =
    rows?.slice(0, DRAIN_BATCH) ??
    (
      await env.DB
        .prepare(`SELECT id, r2_raw_key FROM pending_deletes ORDER BY created ASC, id ASC LIMIT ?`)
        .bind(DRAIN_BATCH)
        .all<Tombstone>()
    ).results ??
    [];
  if (batch.length === 0) return { drained: 0, failed: 0 };
  const ids = batch.map((r) => r.id);
  const marks = placeholders(ids.length);

  const live = new Set(
    (
      (await env.DB.prepare(`SELECT id FROM messages WHERE id IN (${marks})`).bind(...ids).all<{ id: string }>())
        .results ?? []
    ).map((r) => r.id),
  );
  const dead = batch.filter((r) => !live.has(r.id));
  for (const id of live) console.error(`drain ${id}: a message row exists for this tombstone; discarding it, deleting nothing`);

  // One statement for the whole batch. If it fails, no tombstone in the batch
  // may be removed (the search entries may still be there), but the R2 work
  // below is still worth doing.
  let searchCleared = dead.length === 0;
  if (dead.length) {
    try {
      await env.DB
        .prepare(`DELETE FROM messages_fts WHERE message_id IN (${placeholders(dead.length)})`)
        .bind(...dead.map((r) => r.id))
        .run();
      searchCleared = true;
    } catch (e) {
      console.error("drain: search-index delete failed, keeping this batch's tombstones:", errText(e));
    }
  }

  const done: string[] = [...live];
  const failed: string[] = [];
  for (const r of dead) {
    try {
      await deleteMessageR2(env, r.id, r.r2_raw_key);
      (searchCleared ? done : failed).push(r.id);
    } catch (e) {
      failed.push(r.id);
      console.error(`drain ${r.id}: removing stored objects failed, will retry:`, errText(e));
    }
  }

  if (done.length) {
    await env.DB.prepare(`DELETE FROM pending_deletes WHERE id IN (${placeholders(done.length)})`).bind(...done).run();
  }
  if (failed.length) {
    // Back of the queue. Best-effort: if this fails they are merely retried first.
    try {
      for (let i = 0; i < failed.length; i += ID_CHUNK - 1) {
        const chunk = failed.slice(i, i + ID_CHUNK - 1); // `created` takes one bind
        await env.DB
          .prepare(`UPDATE pending_deletes SET created=? WHERE id IN (${placeholders(chunk.length)})`)
          .bind(now, ...chunk)
          .run();
      }
    } catch (e) {
      console.error("drain: could not requeue failed tombstones:", errText(e));
    }
  }
  return { drained: done.length - live.size, failed: failed.length };
}

/** Which rows a state change applies to: a whole conversation, or one message. */
type Scope = "thread_id" | "id";

/** Every action except `delete`: pure state transitions, no storage to clean up. */
export type StateAction = Exclude<MailAction, "delete">;

/**
 * The one definition of each state transition, shared by the conversation-level
 * and message-level entry points so they cannot drift apart. `scope` is one of
 * two literal column names, never caller input.
 */
async function applyStateAction(D: D1Database, scope: Scope, key: string, action: StateAction, now: number, until?: number): Promise<void> {
  switch (action) {
    case "archive":
      // Filing a thread away ends any snooze on it: it should not pop back
      // into the inbox later, and a restore should not resurrect the timer.
      await D.prepare(`UPDATE messages SET state='archived', snoozed_until=NULL WHERE ${scope}=? AND state!='trash'`).bind(key).run();
      return;
    case "snooze": {
      if (!isSnoozeTime(until, now)) throw new Error("snooze needs a time in the future");
      const r = await D.prepare(`UPDATE messages SET snoozed_until=?, woke_at=NULL WHERE ${scope}=? AND state='inbox'`).bind(until, key).run();
      // Only inbox mail can be snoozed. Saying "ok" for an archived thread
      // would have the client announce a snooze that never happened.
      if (r?.meta && r.meta.changes === 0) throw new Error("only mail in the inbox can be snoozed");
      return;
    }
    case "unsnooze":
      await D.prepare(`UPDATE messages SET snoozed_until=NULL WHERE ${scope}=?`).bind(key).run();
      return;
    case "unarchive":
      await D.prepare(`UPDATE messages SET state='inbox' WHERE ${scope}=? AND state='archived'`).bind(key).run();
      return;
    case "trash":
      // Remember each message's pre-trash state so Undo/restore returns it to
      // wherever it was (inbox OR archived), not unconditionally to inbox. Only
      // capture when not already trashed, so a double-trash can't clobber it.
      // Only live messages move. A message already in Trash or Junk stays as
      // it is: trashing a conversation must not turn the junk in it into
      // ordinary trash (which a later Restore would put in the inbox), and
      // re-trashing must not reset the purge clock.
      await D.prepare(
        `UPDATE messages SET pre_trash_state = state, state='trash', trashed_at=?, snoozed_until=NULL WHERE ${scope}=? AND state!='trash'`,
      ).bind(now, key).run();
      return;
    case "spam":
      // Junk is trash with a mark (see migrations/0017-junk.sql): same capture
      // of where it came from, same purge clock, listed under Junk. Reporting a
      // conversation junks what was RECEIVED in it; my own replies are not junk.
      await D.prepare(
        `UPDATE messages SET pre_trash_state = CASE WHEN state!='trash' THEN state ELSE pre_trash_state END, state='trash', trashed_at=?, spam=1, snoozed_until=NULL WHERE ${scope}=?${scope === "thread_id" ? " AND direction='in'" : ""}`,
      ).bind(now, key).run();
      return;
    case "unspam":
      // "Not junk": back to wherever it was. Only junk, never ordinary trash.
      await D.prepare(
        `UPDATE messages SET state=COALESCE(pre_trash_state,'inbox'), pre_trash_state=NULL, trashed_at=NULL, spam=0 WHERE ${scope}=? AND state='trash' AND spam=1`,
      ).bind(key).run();
      return;
    case "restore":
      // Trash only: junk comes back through "not junk" (unspam), so restoring a
      // trashed conversation cannot drop the junk in it into the inbox.
      // Restore to the captured pre-trash state (fallback 'inbox' for rows that
      // predate the column), then clear the capture + trash timestamp.
      await D.prepare(
        `UPDATE messages SET state=COALESCE(pre_trash_state,'inbox'), pre_trash_state=NULL, trashed_at=NULL WHERE ${scope}=? AND state='trash' AND spam=0`,
      ).bind(key).run();
      return;
    case "star":   await D.prepare(`UPDATE messages SET starred=1 WHERE ${scope}=?`).bind(key).run(); return;
    case "unstar": await D.prepare(`UPDATE messages SET starred=0 WHERE ${scope}=?`).bind(key).run(); return;
    case "read":   await D.prepare(`UPDATE messages SET unread=0 WHERE ${scope}=?`).bind(key).run(); return;
    case "unread": await D.prepare(`UPDATE messages SET unread=1 WHERE ${scope}=?`).bind(key).run(); return;
  }
}

/**
 * Apply a state change to ONE message (by internal id), with exactly the
 * transitions a conversation-level action performs. Inbox filters use this:
 * a rule matched one inbound message, and the thread it was filed into is
 * chosen by the sender's References header, so the rest of that thread is not
 * the rule's to move.
 */
export async function mutateMessage(env: MutEnv, messageId: string, action: StateAction, now: number): Promise<void> {
  await applyStateAction(env.DB, "id", messageId, action, now);
}

export async function mutateThread(env: MutEnv, threadId: string, action: MailAction, now: number, until?: number): Promise<void> {
  if (action !== "delete") {
    await applyStateAction(env.DB, "thread_id", threadId, action, now, until);
    return;
  }
  await deleteTrashedInThread(env, threadId, now);
}

/** Ids per claiming statement: the tombstone insert binds `created` as well,
 *  and D1 allows 100 parameters. */
const CLAIM_CHUNK = ID_CHUNK - 1;

/**
 * "Delete forever": permanently remove the TRASHED messages of a thread.
 *
 * Each chunk of ids is claimed in ONE transaction (a D1 batch): write a
 * tombstone for every one of those ids that is still in trash, then delete
 * exactly those rows. Same predicate, same transaction, so the tombstones are
 * precisely the rows removed. That makes a concurrent restore safe: a restore
 * that commits first keeps its row and all of its content (the claim no longer
 * matches it), and one that comes after finds no row. And because the
 * tombstone exists from the instant the row does not, nothing that goes wrong
 * afterwards (an R2 failure, a later chunk throwing, the Worker being killed)
 * can leave the raw message or the search entry of "deleted forever" mail
 * behind with no record: drainPendingDeletes finishes the job, here or from
 * the daily cron.
 *
 * A reply that arrives mid-delete is not among the ids read, so it is not
 * touched, and a trashed thread that has since received a reply is still
 * deletable (only the trashed rows go).
 *
 * Succeeds when at least one row was claimed, however much cleanup is still
 * pending. Throws when nothing was, i.e. nothing in the thread was in trash.
 */
async function deleteTrashedInThread(env: MutEnv, threadId: string, now: number): Promise<void> {
  const rows = await threadRows(env, threadId);
  if (rows.length === 0) return;
  const trashed = rows.filter((r) => r.state === "trash");

  const claimed: Tombstone[] = [];
  const rawKeys = new Map(trashed.map((r) => [r.id, r.r2_raw_key]));
  for (let i = 0; i < trashed.length; i += CLAIM_CHUNK) {
    const chunk = trashed.slice(i, i + CLAIM_CHUNK).map((r) => r.id);
    const predicate = `id IN (${placeholders(chunk.length)}) AND state='trash'`;
    try {
      const [, deleted] = await env.DB.batch<{ id: string }>([
        env.DB
          .prepare(`INSERT OR IGNORE INTO pending_deletes (id, r2_raw_key, created) SELECT id, r2_raw_key, ? FROM messages WHERE ${predicate}`)
          .bind(now, ...chunk),
        env.DB.prepare(`DELETE FROM messages WHERE ${predicate} RETURNING id`).bind(...chunk),
      ]);
      for (const r of deleted.results ?? []) claimed.push({ id: r.id, r2_raw_key: rawKeys.get(r.id) ?? null });
    } catch (e) {
      // Nothing claimed yet: fail loudly (this is also what a missing
      // pending_deletes table looks like, and no row was deleted). Otherwise
      // the earlier chunks are committed and tombstoned; clean those up and
      // leave the rest of the thread in trash.
      if (claimed.length === 0) throw e;
      console.error(`delete ${threadId}: a later chunk failed, the rest stays in trash:`, errText(e));
      break;
    }
  }
  if (claimed.length === 0) throw new Error("delete requires the thread to be in trash");
  try {
    for (let i = 0; i < claimed.length; i += DRAIN_BATCH) {
      await drainPendingDeletes(env, now, claimed.slice(i, i + DRAIN_BATCH));
    }
  } catch (e) {
    // The rows are gone and tombstoned; the cron drain will finish.
    console.error(`delete ${threadId}: cleanup incomplete, left to the daily drain:`, errText(e));
  }
}

export async function mutateThreads(env: MutEnv, threadIds: string[], action: MailAction, now: number, until?: number): Promise<{ count: number }> {
  const ids = threadIds.slice(0, 200);
  for (const id of ids) {
    try {
      await mutateThread(env, id, action, now, until);
    } catch (e) {
      // A bulk snooze over a mixed selection skips what cannot be snoozed
      // rather than stopping halfway through the list. Everything else fails
      // the request as before.
      if (action !== "snooze") throw e;
    }
  }
  return { count: ids.length };
}

const THIRTY_DAYS_MS = 30 * 24 * 3600 * 1000;

/** Most messages purged per cron run. A backlog drains over successive runs,
 *  oldest first. */
export const PURGE_BATCH = 100;

/**
 * Permanently remove mail that has sat in trash past the 30-day cutoff.
 *
 * One transaction claims the batch: it writes a tombstone for each of the
 * oldest PURGE_BATCH rows that are in trash and past the cutoff, then deletes
 * exactly those rows (the same predicate in both statements). A restore
 * therefore either commits before the claim (the row no longer matches and
 * keeps its content) or after it (there is no row left to restore); it can
 * never end up as an inbox message whose body has been deleted.
 *
 * The claimed rows are then cleaned up through their tombstones. Whatever that
 * leaves undone (`pending`) stays recorded and is finished by a later drain,
 * so a message whose objects keep failing to delete neither loses track of
 * them nor holds up the purge queue.
 */
export async function purgeOldTrash(env: MutEnv, now: number): Promise<{ purged: number; pending: number }> {
  const cutoff = now - THIRTY_DAYS_MS;
  const predicate = `id IN (SELECT id FROM messages WHERE state='trash' AND trashed_at < ?1 ORDER BY trashed_at ASC LIMIT ?2)
          AND state='trash' AND trashed_at < ?1`;
  const [, deleted] = await env.DB.batch<Tombstone>([
    env.DB
      .prepare(`INSERT OR IGNORE INTO pending_deletes (id, r2_raw_key, created) SELECT id, r2_raw_key, ?3 FROM messages WHERE ${predicate}`)
      .bind(cutoff, PURGE_BATCH, now),
    env.DB.prepare(`DELETE FROM messages WHERE ${predicate} RETURNING id, r2_raw_key`).bind(cutoff, PURGE_BATCH),
  ]);
  const claimed = deleted.results ?? [];
  let drained = 0;
  try {
    drained = (await drainPendingDeletes(env, now, claimed)).drained;
  } catch (e) {
    console.error("purge: cleanup incomplete, left to the next drain:", errText(e));
  }
  return { purged: claimed.length, pending: claimed.length - drained };
}
