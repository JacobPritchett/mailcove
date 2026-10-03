// D1/R2 helpers kept out of the router to keep index.ts thin.

export interface StoreEnv {
  DB: D1Database;
  MAILSTORE: R2Bucket;
}

// Same column set the list/detail endpoints expose, so thread rows are shaped
// identically to /api/messages rows for the frontend.
const THREAD_COLS =
  "id, thread_id, direction, folder, msg_from, msg_to, msg_cc, subject, snippet, date, unread, has_attachments, message_id, in_reply_to, state, starred, domain, envelope_to, dmarc_pass, from_addr, spam, snoozed_until";

interface ThreadBody {
  text: string;
  html: string;
  /** Present and true when `text` was derived from `html` at ingest (the
   *  message had no text part). Absent otherwise. */
  textDerived?: boolean;
  attachments: { partId?: string; name: string; mimeType: string; size: number; disposition?: string; contentId?: string | null }[];
}

const EMPTY_BODY: ThreadBody = { text: "", html: "", attachments: [] };

/**
 * Look up the thread_id of the earliest stored message whose RFC Message-ID is
 * one of `candidateIds`. Used to join an inbound reply to an existing thread
 * (our own sent message, or an earlier inbound) when its parent is already in
 * the DB. Returns the *earliest* (date ASC) match so a reply collapses onto the
 * thread root rather than a mid-chain message. Returns null when there are no
 * candidates (no query is issued) or nothing matches.
 */
/**
 * Most candidate ids to put in the IN clause.
 *
 * D1 rejects a query with more than 100 bound parameters — verified against the
 * live database: 100 succeeds, 101 fails with "too many SQL variables". A
 * References header grows by one Message-ID per reply, so an ordinary
 * mailing-list thread crosses that on its own, with no attacker involved. Past
 * the limit every later message in the thread would fail this lookup and start
 * its own thread, so cap the list instead. The newest ancestors are kept: they
 * are the ones most likely to be stored here.
 */
const MAX_THREAD_CANDIDATES = 50;

export async function findThreadIdByMessageIds(
  db: D1Database,
  candidateIds: string[],
): Promise<string | null> {
  if (candidateIds.length === 0) return null;
  const ids = candidateIds.slice(-MAX_THREAD_CANDIDATES);
  const placeholders = ids.map(() => "?").join(",");
  const row = await db
    .prepare(
      `SELECT thread_id FROM messages WHERE message_id IN (${placeholders}) ORDER BY date ASC LIMIT 1`,
    )
    .bind(...ids)
    .first<{ thread_id: string }>();
  return row?.thread_id ?? null;
}

/**
 * Stored OUTBOUND rows carrying `messageId`, oldest first: the sent copies an
 * inbound message with that same Message-ID could be the echo of. Returns the
 * sender identity too, because the caller must check it (see ownSentThreadId
 * in index.ts) before trusting the match.
 */
export async function findSentByMessageId(
  db: D1Database,
  messageId: string,
): Promise<{ thread_id: string; msg_from: string | null }[]> {
  const { results } = await db
    .prepare(
      `SELECT thread_id, msg_from FROM messages WHERE message_id=? AND direction='out' ORDER BY date ASC LIMIT 5`,
    )
    .bind(messageId)
    .all<{ thread_id: string; msg_from: string | null }>();
  return results ?? [];
}

/** Most messages returned for one thread; bounds the R2 fan-out below. */
export const THREAD_MESSAGE_LIMIT = 100;

/**
 * Load the messages (inbox + sent) sharing `threadId`, ordered oldest→newest,
 * each enriched with its body loaded from R2 `parsed/<id>.json`. Ordering is
 * delegated to SQL; body loads run concurrently to avoid an N+1 waterfall.
 *
 * A thread longer than THREAD_MESSAGE_LIMIT returns its NEWEST messages (the
 * reader opens on the latest one, and that is what a reply quotes), with
 * `truncated: true` and the real `total` so the client can say so.
 *
 * NOTE: bodies are loaded eagerly (one R2 GET per message), so this endpoint
 * fans out R2 reads proportional to thread length. The LIMIT bounds that fan-out
 * for personal-scale threads; a future optimization is lazy per-message body
 * loading (return rows immediately, fetch each body on demand).
 */
export async function getThread(env: StoreEnv, threadId: string) {
  const where = `WHERE thread_id=?`;
  const bind = <T extends D1PreparedStatement>(stmt: T) => stmt.bind(threadId);
  // Inner query takes the newest LIMIT rows; the outer one puts them back in
  // reading order. rowid breaks ties between messages with the same date.
  const { results } = await bind(
    env.DB.prepare(
      `SELECT ${THREAD_COLS} FROM (
         SELECT ${THREAD_COLS}, rowid AS row_order FROM messages ${where}
          ORDER BY date DESC, rowid DESC LIMIT ${THREAD_MESSAGE_LIMIT}
       ) ORDER BY date ASC, row_order ASC`,
    ),
  ).all();

  const rows = (results ?? []) as Record<string, unknown>[];

  // Only a full page can be hiding more, so the count costs nothing for the
  // overwhelmingly common short thread.
  let total = rows.length;
  if (rows.length >= THREAD_MESSAGE_LIMIT) {
    const counted = await bind(env.DB.prepare(`SELECT COUNT(*) AS n FROM messages ${where}`)).first<{ n: number }>();
    total = Math.max(total, counted?.n ?? 0);
  }

  const messages = await Promise.all(
    rows.map(async (row) => {
      const obj = await env.MAILSTORE.get(`parsed/${row.id}.json`);
      const body = obj ? ((await obj.json()) as ThreadBody) : EMPTY_BODY;
      return { ...row, body };
    }),
  );

  return { thread_id: threadId, messages, total, truncated: total > rows.length };
}
